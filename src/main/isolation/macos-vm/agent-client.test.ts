/**
 * MacAgentClient against a scripted agent on a unix socket: the protocol's
 * order, and every way a hostile guest's answer is refused.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { MacAgentClient, jobEnvNameAllowed, stepEnvNameAllowed } from './agent-client';
import { shortTempDir } from '../../test-utils/vm-fixtures';

const HELLO = { v: 1, event: 'hello', agent: '1.0.0', ready: true, os: '26.6.2', runnerVersions: ['2.330.0'] };

describe('MacAgentClient', () => {
  let dir: string;
  let socketPath: string;
  let server: net.Server;
  let received: Array<Record<string, unknown>>;
  let rawReceived: Buffer;
  let onRequest: (msg: Record<string, unknown>, send: (body: unknown) => void, conn: net.Socket) => void;
  let hello: unknown;
  const clients: MacAgentClient[] = [];

  beforeEach(async () => {
    dir = shortTempDir();
    socketPath = path.join(dir, 'agent.sock');
    received = [];
    rawReceived = Buffer.alloc(0);
    hello = HELLO;
    onRequest = (msg, send) => send({ v: 1, id: msg.id, ok: true });
    server = net.createServer((conn) => {
      const send = (body: unknown) => conn.write(`${typeof body === 'string' ? body : JSON.stringify(body)}\n`);
      if (hello !== null) send(hello);
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString('latin1');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line);
          } catch {
            rawReceived = Buffer.concat([rawReceived, Buffer.from(`${line}\n`, 'latin1')]);
            continue;
          }
          received.push(msg);
          onRequest(msg, send, conn);
        }
        if (buf.length > 0 && !buf.startsWith('{')) {
          rawReceived = Buffer.concat([rawReceived, Buffer.from(buf, 'latin1')]);
          buf = '';
        }
      });
      conn.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const client = (timeoutsMs = {}) => {
    const logs: string[] = [];
    const c = new MacAgentClient({ socketPath, log: (_l, m) => logs.push(m), timeoutsMs });
    clients.push(c);
    return { c, logs };
  };

  it('reads the hello, then prepares the guest with the host time, entropy and both ports', async () => {
    const { c } = client();
    expect(await c.connect()).toEqual({ agent: '1.0.0', ready: true, os: '26.6.2', runnerVersions: ['2.330.0'] });
    const entropy = crypto.randomBytes(32);
    await c.prepare({ timeMs: 1_790_000_000_123, entropy, proxyPort: 5000, brokerPort: 8787 });
    expect(received[0]).toEqual({ v: 1, id: 1, op: 'prepare', timeMs: 1_790_000_000_123, entropy: entropy.toString('base64'), proxyPort: 5000, brokerPort: 8787 });
  });

  it('closes on a hello that is not of its form', async () => {
    for (const bad of [
      { ...HELLO, agent: '1.0.0; rm -rf /' },
      { ...HELLO, ready: 'yes' },
      { ...HELLO, runnerVersions: ['2.330.0', '../x'] },
      { ...HELLO, runnerVersions: Array(17).fill('2.330.0') },
      'not json',
    ]) {
      hello = bad;
      const { c } = client();
      await expect(c.connect()).rejects.toMatchObject({ code: 'E_AGENT_PROTOCOL' });
    }
  });

  it('times out an agent that never says hello', async () => {
    hello = null;
    const { c } = client({ hello: 100 });
    await expect(c.connect()).rejects.toMatchObject({ code: 'E_AGENT_TIMEOUT' });
  });

  it('uploads a runner once the agent says to send, and waits for it to be installed', async () => {
    const bytes = crypto.randomBytes(5000);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    onRequest = (msg, send, conn) => {
      if (msg.op !== 'runner') return;
      send({ v: 1, id: msg.id, ok: true, send: true });
      const collected: Buffer[] = [];
      let total = 0;
      conn.removeAllListeners('data');
      conn.on('data', (chunk: Buffer) => {
        collected.push(chunk);
        total += chunk.length;
        if (total >= (msg.bytes as number)) {
          const got = Buffer.concat(collected).subarray(0, msg.bytes as number);
          expect(crypto.createHash('sha256').update(got).digest('hex')).toBe(sha256);
          send({ v: 1, id: msg.id, ok: true, installed: msg.version });
        }
      });
    };
    const { c } = client();
    await c.connect();
    await c.uploadRunner('2.331.0', bytes, sha256);
    expect(received[0]).toEqual({ v: 1, id: 1, op: 'runner', version: '2.331.0', bytes: 5000, sha256 });
  });

  it('starts a job and passes on its output, cleaned, and its exit', async () => {
    onRequest = (msg, send) => {
      if (msg.op !== 'job') return;
      send({ v: 1, id: msg.id, ok: true, pid: 4242 });
      send({ v: 1, event: 'output', stream: 'stdout', data: 'step \u001b[31mone\u001b[0m\u0007 done' });
      send({ v: 1, event: 'output', stream: 'stderr', data: 'warn' });
      send({ v: 1, event: 'exit', code: 3, signal: null });
    };
    const { c } = client();
    await c.connect();
    const lines: string[] = [];
    c.on('output', (stream, line) => lines.push(`${stream}: ${line}`));
    const exit = new Promise((resolve) => c.once('exit', (code, signal) => resolve([code, signal])));
    const files = { '.runner': '{}', '.credentials': '{}', '.credentials_rsaparams': '{}' };
    expect(await c.job({ runnerVersion: '2.330.0', files, env: { LANG: 'C' }, args: ['--once'] })).toBe(4242);
    expect(await exit).toEqual([3, null]);
    expect(lines).toEqual(['stdout: step one  done', 'stderr: warn']);
    expect(received[0]).toMatchObject({ op: 'job', runnerVersion: '2.330.0', files, env: { LANG: 'C' }, args: ['--once'] });
  });

  it('closes on output or an exit from no job, an answer to no request, or a malformed exit', async () => {
    for (const bad of [
      { v: 1, event: 'output', stream: 'stdout', data: 'x' },
      { v: 1, event: 'exit', code: 0, signal: null },
      { v: 1, id: 99, ok: true },
      { v: 1, event: 'teleported' },
    ]) {
      onRequest = (msg, send) => {
        send({ v: 1, id: msg.id, ok: true, jobStarted: false });
        send(bad);
      };
      const { c } = client();
      await c.connect();
      const closed = new Promise((resolve) => c.once('closed', resolve));
      await c.ping();
      expect(await closed).toMatchObject({ code: 'E_AGENT_PROTOCOL' });
    }
    onRequest = (msg, send) => {
      send({ v: 1, id: msg.id, ok: true, pid: 4242 });
      send({ v: 1, event: 'exit', code: 0, signal: 'SIGKILL' });
    };
    const { c } = client();
    await c.connect();
    const files = { '.runner': '', '.credentials': '', '.credentials_rsaparams': '' };
    const closed = new Promise((resolve) => c.once('closed', resolve));
    await c.job({ runnerVersion: '2.330.0', files, env: {}, args: ['--once'] });
    expect(await closed).toMatchObject({ code: 'E_AGENT_PROTOCOL' });
  });

  it("sends a test run's workspace once the agent says to, and waits for it to be unpacked", async () => {
    const bytes = crypto.randomBytes(3000);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    let got = Buffer.alloc(0);
    onRequest = (msg, send, conn) => {
      if (msg.op !== 'put') return;
      send({ v: 1, id: msg.id, ok: true, send: true });
      conn.removeAllListeners('data');
      conn.on('data', (chunk: Buffer) => {
        got = Buffer.concat([got, chunk]);
        if (got.length >= (msg.bytes as number)) send({ v: 1, id: msg.id, ok: true, put: msg.dest });
      });
    };
    const { c } = client();
    await c.connect();
    await c.put('workspace', bytes, sha256);
    expect(received[0]).toEqual({ v: 1, id: 1, op: 'put', dest: 'workspace', bytes: 3000, sha256 });
    expect(got.equals(bytes)).toBe(true);
    await expect(c.put('../x' as never, bytes, sha256)).rejects.toThrow(/not an upload destination/);
    await expect(c.put('actions/0123456789ABCDEF', bytes, sha256)).rejects.toThrow(/not an upload destination/);
    await expect(c.put('workspace', Buffer.alloc(0), sha256)).rejects.toThrow(/1 to/);
  });

  it("runs a test run's steps one after another, each with its output, exit and outputs", async () => {
    let pid = 5000;
    onRequest = (msg, send) => {
      if (msg.op !== 'step') return;
      send({ v: 1, id: msg.id, ok: true, pid: ++pid });
      // Output and exit can come in the same read as the answer.
      send({ v: 1, event: 'output', stream: 'stdout', data: `step ${pid}` });
      send({ v: 1, event: 'exit', code: pid === 5001 ? 0 : null, signal: pid === 5001 ? null : 'SIGKILL', outputs: `n=${pid}\n` });
    };
    const { c } = client();
    await c.connect();
    const events: unknown[] = [];
    c.on('output', (stream, line) => events.push([stream, line]));
    c.on('stepExit', (code, signal, outputs) => events.push([code, signal, outputs]));
    expect(await c.step({ program: 'bash', script: 'echo hi', cwd: 'workspace', env: { LANG: 'C' } })).toBe(5001);
    expect(await c.step({ program: 'node', entry: 'actions/0123456789abcdef/index.js', cwd: 'workspace', env: {} })).toBe(5002);
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual([['stdout', 'step 5001'], [0, null, 'n=5001\n'], ['stdout', 'step 5002'], [null, 'SIGKILL', 'n=5002\n']]);
    expect(received[0]).toEqual({ v: 1, id: 1, op: 'step', program: 'bash', script: 'echo hi', cwd: 'workspace', env: { LANG: 'C' } });
    expect(received[1]).toEqual({ v: 1, id: 2, op: 'step', program: 'node', entry: 'actions/0123456789abcdef/index.js', cwd: 'workspace', env: {} });
  });

  it('closes on a step exit without its outputs, or with more than a step may write, and on output after it', async () => {
    for (const bad of [
      [{ v: 1, event: 'exit', code: 0, signal: null }],
      [{ v: 1, event: 'exit', code: 0, signal: null, outputs: 5 }],
      [{ v: 1, event: 'exit', code: 0, signal: null, outputs: 'x'.repeat(16 * 1024 + 1) }],
      [{ v: 1, event: 'exit', code: 0, signal: null, outputs: '' }, { v: 1, event: 'output', stream: 'stdout', data: 'late' }],
    ]) {
      onRequest = (msg, send) => {
        send({ v: 1, id: msg.id, ok: true, pid: 4242 });
        for (const line of bad) send(line);
      };
      const { c } = client();
      await c.connect();
      const closed = new Promise((resolve) => c.once('closed', resolve));
      await c.step({ program: 'sh', script: 'true', cwd: 'workspace', env: {} });
      expect(await closed).toMatchObject({ code: 'E_AGENT_PROTOCOL' });
    }
  });

  it('refuses here a step whose command would not fit one line', async () => {
    const { c } = client();
    await c.connect();
    await expect(c.step({ program: 'bash', script: 'x'.repeat(70 * 1024), cwd: 'workspace', env: {} })).rejects.toMatchObject({
      code: 'E_STEP_TOO_LARGE',
    });
    expect(received).toEqual([]);
  });

  it('rejects a refused request with the guest\'s message, cleaned', async () => {
    onRequest = (msg, send) => send({ v: 1, id: msg.id, ok: false, code: 'E_PROTO', message: 'a job already\nran in this VM' });
    const { c } = client();
    await c.connect();
    await expect(c.signal('TERM')).rejects.toMatchObject({ code: 'E_AGENT_REFUSED', message: 'a job already ran in this VM' });
  });

  it('closes when a request is not answered in time', async () => {
    onRequest = () => {};
    const { c } = client({ prepare: 100 });
    await c.connect();
    await expect(c.prepare({ timeMs: 1_790_000_000_000, entropy: crypto.randomBytes(32), proxyPort: 1, brokerPort: 2 })).rejects.toMatchObject({
      code: 'E_AGENT_TIMEOUT',
    });
  });
});

describe('jobEnvNameAllowed', () => {
  // The rule the agent holds every job to (MacVMAgentCore.jobEnvNameAllowed):
  // what the backend sends past it the agent refuses, and the job with it.
  it("allows the runner's settings, and a name a repository's env policy passes", () => {
    for (const name of ['HTTPS_PROXY', 'ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT', 'RUNNER_DEBUG', 'LANG', 'DEVELOPER_DIR', 'FASTLANE_USER', '_FLAG']) {
      expect([name, jobEnvNameAllowed(name)]).toEqual([name, true]);
    }
  });

  it("refuses what the agent sets, and what reaches the loader, the shell or the runner's own code", () => {
    for (const name of [
      'PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'IFS', 'NODE_OPTIONS',
      'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'DOTNET_STARTUP_HOOKS', 'COMPlus_EnableDiagnostics',
      'RUNNER_ALLOW_RUNASROOT', 'ACTIONS_RUNNER_HOOK_JOB_STARTED', 'GITHUB_TOKEN', 'BASH_FUNC_x%%',
    ]) {
      expect([name, jobEnvNameAllowed(name)]).toEqual([name, false]);
    }
  });

  it('refuses anything but a plain name of at most 128 characters', () => {
    for (const name of ['', '1ABC', 'A-B', 'A B', 'É', 'A=B', 'A'.repeat(129)]) {
      expect([name, jobEnvNameAllowed(name)]).toEqual([name, false]);
    }
    expect(jobEnvNameAllowed('A'.repeat(128))).toBe(true);
  });
});

describe('stepEnvNameAllowed', () => {
  // The rule the agent holds a test run's steps to (MacVMAgentCore.stepEnvNameAllowed).
  it('allows what a job may be given, and the GITHUB_* and RUNNER_* variables a step reads', () => {
    for (const name of ['LANG', 'HTTPS_PROXY', 'INPUT_WHO', 'GITHUB_WORKSPACE', 'GITHUB_SHA', 'RUNNER_TEMP', 'RUNNER_OS', 'GIT_HTTP_PROXY_AUTHMETHOD']) {
      expect([name, stepEnvNameAllowed(name)]).toEqual([name, true]);
    }
  });

  it('refuses what the agent sets, and what reaches the loader or how the shell starts', () => {
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'BASH_ENV', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'GITHUB_A-B', 'RUNNER_É', `GITHUB_${'A'.repeat(130)}`]) {
      expect([name, stepEnvNameAllowed(name)]).toEqual([name, false]);
    }
  });
});
