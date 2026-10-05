/**
 * How `localmost test` drives its macOS VM: the steps through the guest
 * agent (faked here by a directory standing in for the guest), and the VM
 * itself borrowed from the running app over its CLI socket.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { closedPort, dryRunRunner, leaseTestVm, tarDirectory, VmStepRunner } from './test-vm';
import { FakeGuest } from './test-utils/fake-guest';
import { GUEST_TEST_ROOT, GUEST_WORKSPACE } from '../main/isolation/macos-vm/agent-client';
import type { RunnerStep } from '../shared/step-executor';

let scratch: string;

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'test-vm-')));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

const step = (overrides: Partial<RunnerStep> = {}): RunnerStep & { lines: string[] } => {
  const lines: string[] = [];
  return {
    program: 'bash',
    script: 'echo hi',
    cwd: GUEST_WORKSPACE,
    env: {},
    onLine: (line, stream) => lines.push(`${stream}: ${line}`),
    lines,
    ...overrides,
  };
};

describe('VmStepRunner', () => {
  let checkout: string;
  let guest: FakeGuest;
  let notes: string[];
  let runner: VmStepRunner;

  beforeEach(async () => {
    checkout = path.join(scratch, 'checkout');
    fs.mkdirSync(path.join(checkout, 'src'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'src', 'main.txt'), 'from the checkout\n');
    fs.symlinkSync('/etc/hosts', path.join(checkout, 'hosts-link'));
    fs.mkdirSync(path.join(scratch, 'guest'));
    guest = new FakeGuest(path.join(scratch, 'guest'));
    notes = [];
    runner = new VmStepRunner(guest, { onNote: (n) => notes.push(n) });
    await runner.putWorkspace(checkout);
  });

  afterEach(() => runner.close());

  it('sends the checkout in as the workspace, links kept as links', () => {
    expect(runner.workDir).toBe(GUEST_WORKSPACE);
    expect(guest.puts.map((p) => p.dest)).toEqual(['workspace']);
    const workspace = path.join(guest.root, 'workspace');
    expect(fs.readFileSync(path.join(workspace, 'src', 'main.txt'), 'utf8')).toBe('from the checkout\n');
    expect(fs.readlinkSync(path.join(workspace, 'hosts-link'))).toBe('/etc/hosts');
  });

  it('runs a step in the guest and hands back its output, exit and GITHUB_OUTPUT', async () => {
    const s = step({
      script: 'cat src/main.txt; echo oops >&2; echo "result=$GREETING" >> "$GITHUB_OUTPUT"; exit 3',
      env: { GREETING: 'hello', GITHUB_WORKSPACE: GUEST_WORKSPACE },
    });
    const result = await runner.run(s);
    expect(result).toEqual({ exitCode: 3, outputs: 'result=hello\n' });
    expect(s.lines).toEqual(['stdout: from the checkout', 'stderr: oops']);
    expect(guest.steps[0]).toMatchObject({ program: 'bash', cwd: 'workspace', env: { GREETING: 'hello', GITHUB_WORKSPACE: GUEST_WORKSPACE } });
  });

  it("passes only the names a step may be given, and says once which it left out", async () => {
    await runner.run(step({ env: { NODE_OPTIONS: '--require x', DYLD_INSERT_LIBRARIES: '/x', PATH: '/x', RUNNER_TEMP: '/t', LANG: 'C' } }));
    await runner.run(step({ env: { NODE_OPTIONS: '--require x' } }));
    expect(guest.steps[0].env).toEqual({ RUNNER_TEMP: '/t', LANG: 'C' });
    expect(guest.steps[1].env).toEqual({});
    expect(notes.filter((n) => n.startsWith('NODE_OPTIONS'))).toHaveLength(1);
    expect(notes.map((n) => n.split(' ')[0]).sort()).toEqual(['DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'PATH']);
  });

  it('starts a step only inside the test run, and sends paths relative to it', async () => {
    fs.mkdirSync(path.join(guest.root, 'workspace', 'sub'));
    await runner.run(step({ cwd: `${GUEST_WORKSPACE}/sub`, script: 'pwd' }));
    expect(guest.steps[0].cwd).toBe('workspace/sub');
    for (const cwd of ['/Users/runner', `${GUEST_WORKSPACE}/../..`, '/tmp', `${GUEST_TEST_ROOT}x/workspace`]) {
      await expect(runner.run(step({ cwd }))).rejects.toThrow(/not inside the macOS VM's test run/);
    }
    expect(guest.steps).toHaveLength(1);
  });

  it("sends an action's code in once, under its own directory, and runs node from it", async () => {
    const action = path.join(scratch, 'action');
    fs.mkdirSync(path.join(action, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(action, 'dist', 'index.js'), 'require("fs").appendFileSync(process.env.GITHUB_OUTPUT, "ran=" + process.cwd() + "\\n");');
    const guestDir = await runner.provide(action);
    expect(await runner.provide(action)).toBe(guestDir);
    expect(guestDir).toMatch(new RegExp(`^${GUEST_TEST_ROOT}/actions/[0-9a-f]{16}$`));
    expect(guest.puts.map((p) => p.dest)).toEqual(['workspace', guestDir.slice(GUEST_TEST_ROOT.length + 1)]);
    const result = await runner.run(step({ program: 'node', script: undefined, entry: `${guestDir}/dist/index.js` }));
    expect(result.outputs).toBe(`ran=${path.join(guest.root, 'workspace')}\n`);
    expect(guest.steps[0]).toMatchObject({ program: 'node', entry: `${guestDir.slice(GUEST_TEST_ROOT.length + 1)}/dist/index.js` });
  });

  it("ends what a job's steps left running, and fails a step whose agent goes away", async () => {
    await runner.endJob();
    expect(guest.signals).toEqual(['KILL']);
    const running = runner.run(step({ script: 'sleep 30' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    guest.close();
    await expect(running).rejects.toThrow(/lost the macOS VM's agent/);
    await expect(runner.run(step())).rejects.toThrow(/lost the macOS VM's agent/);
  });
});

describe('tarDirectory', () => {
  it('refuses a directory over the most a run sends in', async () => {
    const dir = path.join(scratch, 'big');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'blob'), Buffer.alloc(64 * 1024));
    await expect(tarDirectory(dir, 16 * 1024)).rejects.toThrow(/over .* MiB/);
    expect((await tarDirectory(dir)).length).toBeGreaterThan(64 * 1024);
  });
});

describe('closing a VmStepRunner', () => {
  it('closes the agent at once, and says it is released only once its VM is let go', async () => {
    fs.mkdirSync(path.join(scratch, 'guest'));
    const guest = new FakeGuest(path.join(scratch, 'guest'));
    let letGo!: () => void;
    const runner = new VmStepRunner(guest, { onClose: () => new Promise<void>((resolve) => { letGo = resolve; }) });
    let released = false;
    runner.close();
    const waiting = runner.released().then(() => { released = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(released).toBe(false);
    letGo();
    await waiting;
    expect(released).toBe(true);
    // A second close does not let it go twice.
    runner.close();
    await runner.released();
  });
});

describe('dryRunRunner', () => {
  it('names the workspace and runs nothing', async () => {
    const r = dryRunRunner();
    expect(r.workDir).toBe(GUEST_WORKSPACE);
    await expect(r.run(step())).rejects.toThrow(/dry run/);
    await expect(r.endJob()).resolves.toBeUndefined();
  });
});

describe('closedPort', () => {
  it('takes a connection and closes it at once', async () => {
    const port = await closedPort();
    try {
      const closed = await new Promise<boolean>((resolve) => {
        const s = net.connect(port.port, '127.0.0.1');
        s.on('close', () => resolve(true));
        s.on('error', () => resolve(true));
      });
      expect(closed).toBe(true);
    } finally {
      port.close();
    }
  });
});

describe('leaseTestVm', () => {
  let socketPath: string;
  let server: net.Server | null;
  let requests: unknown[];
  let closedByClient: Promise<void>;

  const serve = (answer: (request: Record<string, unknown>) => unknown) =>
    new Promise<void>((resolve) => {
      let markClosed: () => void;
      closedByClient = new Promise((r) => (markClosed = r));
      server = net.createServer((conn) => {
        let buf = '';
        conn.setEncoding('utf8');
        conn.on('data', (chunk: string) => {
          buf += chunk;
          const nl = buf.indexOf('\n');
          if (nl === -1) return;
          const request = JSON.parse(buf.slice(0, nl));
          requests.push(request);
          const reply = answer(request);
          conn.write(`${typeof reply === 'string' ? reply : JSON.stringify(reply)}\n`);
        });
        conn.on('close', () => markClosed());
      });
      server.listen(socketPath, resolve);
    });

  beforeEach(() => {
    socketPath = path.join(scratch, 'localmost.sock');
    server = null;
    requests = [];
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
  });

  it('asks the app for a VM with the run\'s ports, and holds it until released', async () => {
    await serve(() => ({ success: true, command: 'test-vm', data: { agentSocket: '/data/macos-vm/vms/1-abc/agent.sock' } }));
    const lease = await leaseTestVm({ proxyPort: 41000, brokerPort: 41001 }, socketPath);
    expect(lease.agentSocket).toBe('/data/macos-vm/vms/1-abc/agent.sock');
    expect(requests).toEqual([{ command: 'test-vm', args: { proxyPort: 41000, brokerPort: 41001 } }]);
    lease.release();
    await closedByClient;
  });

  it('ends the lease by asking the app to release the VM, and waits for its answer', async () => {
    let answerRelease!: () => void;
    let conn!: net.Socket;
    server = net.createServer((c) => {
      conn = c;
      let buf = '';
      c.setEncoding('utf8');
      c.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const request = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          requests.push(request);
          if (request.command === 'test-vm') {
            c.write(`${JSON.stringify({ success: true, command: 'test-vm', data: { agentSocket: '/a/agent.sock' } })}\n`);
          } else {
            answerRelease = () => c.write(`${JSON.stringify({ success: true, command: 'test-vm-release' })}\n`);
          }
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    const lease = await leaseTestVm({ proxyPort: 1, brokerPort: 2 }, socketPath);
    let ended = false;
    const ending = lease.end().then(() => { ended = true; });
    for (let i = 0; i < 100 && !answerRelease; i++) await new Promise((r) => setTimeout(r, 10));
    expect(requests).toEqual([{ command: 'test-vm', args: { proxyPort: 1, brokerPort: 2 } }, { command: 'test-vm-release' }]);
    await new Promise((r) => setTimeout(r, 50));
    expect(ended).toBe(false);
    const closed = new Promise<void>((r) => conn.once('close', () => r()));
    answerRelease();
    await ending;
    await closed;
  });

  it('lets the lease go after a bound when the app never says the VM is gone', async () => {
    // Answers test-vm, and never the release.
    let markClosed!: () => void;
    closedByClient = new Promise((r) => (markClosed = r));
    server = net.createServer((c) => {
      c.once('data', () => c.write(`${JSON.stringify({ success: true, command: 'test-vm', data: { agentSocket: '/a/agent.sock' } })}\n`));
      c.on('close', () => markClosed());
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    const lease = await leaseTestVm({ proxyPort: 1, brokerPort: 2 }, socketPath);
    const started = Date.now();
    await lease.end(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    await closedByClient;
  });

  it('names the setup step when no golden image is ready', async () => {
    await serve(() => ({ success: false, error: 'No macOS VM can run the workflow: no golden macOS image has been built: build one in Settings' }));
    await expect(leaseTestVm({ proxyPort: 1, brokerPort: 2 }, socketPath)).rejects.toThrow(
      /no golden macOS image has been built.*Settings > macOS VM > Build the golden image/
    );
  });

  it('says to start the app when it is not running', async () => {
    await expect(leaseTestVm({ proxyPort: 1, brokerPort: 2 }, socketPath)).rejects.toThrow(/localmost start/);
  });

  it('refuses an answer that is not of its form', async () => {
    for (const bad of ['not json', { success: true, command: 'status', data: {} }, { success: true, command: 'test-vm', data: { agentSocket: 'relative.sock' } }]) {
      await serve(() => bad);
      await expect(leaseTestVm({ proxyPort: 1, brokerPort: 2 }, socketPath)).rejects.toThrow(/localmost app sent/);
      await new Promise((resolve) => server!.close(resolve));
      server = null;
    }
  });

  it('gives up on an app that never answers', async () => {
    await serve(() => '');
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const lease = leaseTestVm({ proxyPort: 1, brokerPort: 2 }, socketPath, 1000);
      const assertion = expect(lease).rejects.toThrow(/did not start a macOS VM in time/);
      await new Promise((resolve) => setImmediate(resolve));
      jest.advanceTimersByTime(1001);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });
});
