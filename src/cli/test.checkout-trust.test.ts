/**
 * What `localmost test` lets a checkout grant itself before anyone agrees,
 * and how a run reaches its macOS VM.
 *
 * A checkout's .localmostrc is its own to write, and so is its workflow.
 * Applied without asking, a policy's network.allow would let the checkout's
 * code send whatever the run hands it to any host it names. These hold the
 * run until the user has seen what the checkout asks for, and say what the
 * VM does not give it yet.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { confirmCheckoutGrants, grantsBeyondWorkspace, runTest, unprovidedGrants, type TestDeps } from './test';
import { VmStepRunner } from './test-vm';
import { FakeGuest } from './test-utils/fake-guest';
import { GUEST_WORKSPACE } from '../main/isolation/macos-vm/agent-client';
import { getRepositoryFromDir } from '../shared/workspace';
import type { RunnerStep, StepRunner } from '../shared/step-executor';

let scratch: string;
let checkout: string;
const savedConfigDir = process.env.LOCALMOST_CONFIG_DIR;

beforeEach(() => {
  const build = path.join(process.cwd(), 'build');
  fs.mkdirSync(build, { recursive: true });
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(build, 'checkout-trust-')));
  process.env.LOCALMOST_CONFIG_DIR = path.join(scratch, 'appdata');
  checkout = path.join(scratch, 'checkout');
  fs.mkdirSync(checkout);
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
  else process.env.LOCALMOST_CONFIG_DIR = savedConfigDir;
  fs.rmSync(scratch, { recursive: true, force: true });
});

const reachOut = { network: { allow: ['evil.example.com'] } };

describe('grantsBeyondWorkspace', () => {
  it('lists every host the policy allows', () => {
    expect(grantsBeyondWorkspace(reachOut)).toEqual([{ label: 'network.allow', items: ['evil.example.com'] }]);
  });

  it('asks nothing about filesystem grants, which the macOS VM does not give', () => {
    expect(grantsBeyondWorkspace({ filesystem: { read: ['~/**'], write: ['~/Library/LaunchAgents'] } })).toEqual([]);
    expect(grantsBeyondWorkspace(undefined)).toEqual([]);
  });
});

describe('unprovidedGrants', () => {
  it('names the filesystem grants and the docker policy a step in the macOS VM goes without', () => {
    const notes = unprovidedGrants({ filesystem: { read: ['~/.npm'], write: ['~/.cache'] }, docker: { pull: { allow: ['node:*'] } } } as never);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/not provided in the macOS VM yet.*read ~\/\.npm, write ~\/\.cache/);
    expect(notes[1]).toMatch(/Docker is not available in the macOS VM yet/);
    expect(unprovidedGrants(reachOut)).toEqual([]);
  });
});

describe('confirmCheckoutGrants', () => {
  const grants = grantsBeyondWorkspace(reachOut);

  it('refuses without a terminal to ask on, unless --yes was passed', async () => {
    const ask = jest.fn(async () => 'y');
    expect(await confirmCheckoutGrants(checkout, grants, { assumeYes: false, isTTY: false, ask })).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    expect(await confirmCheckoutGrants(checkout, grants, { assumeYes: true, isTTY: false, ask })).toBe(true);
  });

  it('asks on a terminal, and remembers a yes for this checkout and these grants only', async () => {
    const no = jest.fn(async () => 'n');
    expect(await confirmCheckoutGrants(checkout, grants, { assumeYes: false, isTTY: true, ask: no })).toBe(false);
    expect(no).toHaveBeenCalledTimes(1);

    const yes = jest.fn(async () => 'y');
    expect(await confirmCheckoutGrants(checkout, grants, { assumeYes: false, isTTY: true, ask: yes })).toBe(true);
    const never = jest.fn(async () => 'n');
    expect(await confirmCheckoutGrants(checkout, grants, { assumeYes: false, isTTY: false, ask: never })).toBe(true);
    expect(never).not.toHaveBeenCalled();

    // Anything more - or the same grants from another checkout - is asked again.
    const more = grantsBeyondWorkspace({ network: { allow: ['evil.example.com', 'worse.example.com'] } });
    expect(await confirmCheckoutGrants(checkout, more, { assumeYes: false, isTTY: false, ask: never })).toBe(false);
    const other = path.join(scratch, 'other');
    fs.mkdirSync(other);
    expect(await confirmCheckoutGrants(other, grants, { assumeYes: false, isTTY: false, ask: never })).toBe(false);
  });

  it('asks nothing when the policy grants nothing beyond the workspace', async () => {
    const ask = jest.fn(async () => 'n');
    expect(await confirmCheckoutGrants(checkout, [], { assumeYes: false, isTTY: false, ask })).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('runTest', () => {
  const originalCwd = process.cwd();
  // git for the checkout's identity, a copy of the checkout as the
  // workspace, a real proxy and tar: on a loaded machine, seconds.
  const RUN_TIMEOUT_MS = 60_000;
  let logs: string[];

  beforeEach(() => {
    fs.mkdirSync(path.join(checkout, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(checkout, '.github', 'workflows', 'ci.yml'),
      'name: CI\non: push\njobs:\n  build:\n    runs-on: macos-latest\n    steps:\n      - run: echo "built $GITHUB_REPOSITORY" && echo "out=1" >> "$GITHUB_OUTPUT"\n'
    );
    process.chdir(checkout);
    logs = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    jest.mocked(console.log).mockRestore();
  });

  /** A run whose VM is a FakeGuest: the workspace sent in by tar, each step run there. */
  const fakeVm = (): { deps: TestDeps; guest: () => FakeGuest; closed: () => boolean } => {
    let guest: FakeGuest | null = null;
    let closed = false;
    return {
      deps: {
        openRunner: async ({ hostWorkDir, onNote }) => {
          const root = path.join(scratch, 'guest');
          fs.mkdirSync(root);
          guest = new FakeGuest(root);
          const runner = new VmStepRunner(guest, { onNote, onClose: () => { closed = true; } });
          await runner.putWorkspace(hostWorkDir);
          return runner;
        },
      },
      guest: () => guest!,
      closed: () => closed,
    };
  };

  it("runs the workflow's steps in the VM, with the checkout sent in as the workspace", async () => {
    fs.writeFileSync(path.join(checkout, 'marker.txt'), 'in the checkout');
    const vm = fakeVm();
    const result = await runTest({ verbose: true }, vm.deps);
    expect(result.success).toBe(true);
    const guest = vm.guest();
    expect(guest.puts[0].dest).toBe('workspace');
    expect(fs.readFileSync(path.join(guest.root, 'workspace', 'marker.txt'), 'utf8')).toBe('in the checkout');
    // RUNNER_TEMP and RUNNER_TOOL_CACHE are there before the first step.
    expect(fs.statSync(path.join(guest.root, 'workspace', '.runner-temp')).isDirectory()).toBe(true);
    expect(guest.steps).toHaveLength(1);
    expect(guest.steps[0]).toMatchObject({ program: 'bash', cwd: 'workspace' });
    expect(guest.steps[0].env).toMatchObject({ GITHUB_WORKSPACE: GUEST_WORKSPACE, GIT_HTTP_PROXY_AUTHMETHOD: 'basic' });
    expect(guest.steps[0].env.HTTPS_PROXY).toMatch(/^http:\/\/localmost:[0-9a-f]+@127\.0\.0\.1:\d+$/);
    expect(guest.steps[0].env.PATH).toBeUndefined();
    expect(guest.steps[0].env.HOME).toBeUndefined();
    expect(logs.join('\n')).toMatch(/built local\/repo|built [\w.-]+\/[\w.-]+/);
    // The job's strays ended with it, and the VM with the run.
    expect(guest.signals).toEqual(['KILL']);
    expect(vm.closed()).toBe(true);
  }, RUN_TIMEOUT_MS);

  it("gives the VM's step the run's GITHUB_* values whatever the workflow, job or step env says", async () => {
    // All three are the checkout's to write, and GitHub lets none of them
    // replace a default: the step in the guest must see this checkout's
    // repository and its own job's name.
    fs.writeFileSync(
      path.join(checkout, '.github', 'workflows', 'ci.yml'),
      [
        'name: CI', 'on: push',
        'env:', '  GITHUB_RUN_ID: "1"', '  WORKFLOW_ONLY: w',
        'jobs:', '  build:', '    runs-on: macos-latest',
        '    env:', '      GITHUB_REPOSITORY: victim/repo', '      GITHUB_JOB: deploy', '      JOB_ONLY: j',
        '    steps:', '      - run: "true"',
        '        env:', '          GITHUB_REPOSITORY: victim/repo', '          RUNNER_NAME: other', '          GITHUB_TOKEN: from-the-step',
        '',
      ].join('\n')
    );
    const vm = fakeVm();
    const result = await runTest({}, vm.deps);
    expect(result.success).toBe(true);
    const env = vm.guest().steps[0].env;
    expect(env.GITHUB_REPOSITORY).toBe(getRepositoryFromDir(checkout) || 'local/repo');
    expect(env.GITHUB_REPOSITORY).not.toBe('victim/repo');
    expect(env.GITHUB_RUN_ID).not.toBe('1');
    expect(env).toMatchObject({ GITHUB_JOB: 'build', RUNNER_NAME: 'localmost', GITHUB_TOKEN: 'from-the-step', WORKFLOW_ONLY: 'w', JOB_ONLY: 'j' });
  }, RUN_TIMEOUT_MS);

  it('does not run a checkout whose policy reaches the network without confirmation', async () => {
    fs.writeFileSync(path.join(checkout, '.localmostrc'), 'version: 1\nshared:\n  network:\n    allow:\n      - evil.example.com\n');
    const vm = fakeVm();
    // Jest's stdin is not a terminal, and --yes was not passed.
    await expect(runTest({}, vm.deps)).rejects.toThrow(/--yes/);
    expect(fs.existsSync(path.join(scratch, 'appdata', 'workspaces'))).toBe(false);
    expect(fs.existsSync(path.join(scratch, 'guest'))).toBe(false);
  }, RUN_TIMEOUT_MS);

  it('runs a checkout that declares filesystem grants, saying the VM does not give them', async () => {
    fs.writeFileSync(path.join(checkout, '.localmostrc'), 'version: 1\nshared:\n  filesystem:\n    write:\n      - ~/Library/LaunchAgents\n');
    const vm = fakeVm();
    const result = await runTest({}, vm.deps);
    expect(result.success).toBe(true);
    expect(logs.join('\n')).toMatch(/Filesystem grants are not provided in the macOS VM yet; this run goes without: write ~\/Library\/LaunchAgents/);
  }, RUN_TIMEOUT_MS);

  it('says network.loopback is ignored, and runs anyway', async () => {
    fs.writeFileSync(path.join(checkout, '.localmostrc'), 'version: 1\nshared:\n  network:\n    loopback: true\n');
    const result = await runTest({}, fakeVm().deps);
    expect(result.success).toBe(true);
    expect(logs.join('\n')).toMatch(/network\.loopback is ignored/);
  }, RUN_TIMEOUT_MS);

  it('fails clearly, and leaves nothing listening, when the app is not running to lend a VM', async () => {
    const stop = jest.spyOn((await import('../shared/discovery-proxy')).DiscoveryProxy.prototype, 'stop');
    try {
      await expect(runTest({})).rejects.toThrow(/macOS VM, which the localmost app runs: start it with `localmost start`/);
      expect(stop).toHaveBeenCalled();
    } finally {
      stop.mockRestore();
    }
  }, RUN_TIMEOUT_MS);

  /**
   * Run the checkout's workflow with a runner whose one step asks the run's
   * proxy for each target in turn through CONNECT, as a step in the guest
   * would through its relay, and return what it answered each.
   */
  const proxyAnswers = async (targets: string[], options: Parameters<typeof runTest>[0]): Promise<string[]> => {
    const answers: string[] = [];
    const runner: StepRunner & { close(): void } = {
      workDir: GUEST_WORKSPACE,
      provide: () => Promise.reject(new Error('no actions here')),
      endJob: () => Promise.resolve(),
      close: () => {},
      run: async (step: RunnerStep) => {
        const proxyUrl = new URL(step.env.HTTPS_PROXY);
        const auth = `Basic ${Buffer.from(`${proxyUrl.username}:${proxyUrl.password}`).toString('base64')}`;
        for (const target of targets) {
          answers.push(await new Promise<string>((resolve) => {
            const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname, () =>
              socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${auth}\r\n\r\n`));
            let data = '';
            socket.on('data', (chunk) => { data += chunk.toString(); });
            socket.on('close', () => resolve(data));
            socket.on('error', () => resolve(data));
          }));
        }
        return { exitCode: 0, outputs: '' };
      },
    };
    const result = await runTest(options, { openRunner: async () => runner });
    expect(result.success).toBe(true);
    return answers;
  };

  it("holds a step to the checkout's network deny list and ports, as a runner job is held", async () => {
    fs.writeFileSync(
      path.join(checkout, '.localmostrc'),
      'version: 1\nshared:\n  network:\n    allow:\n      - "*.example.com"\n    deny:\n      - bad.example.com\n'
    );
    const refusals = await proxyAnswers(['bad.example.com:443', 'ok.example.com:22'], { assumeYes: true });
    // Refused by the policy itself, before any lookup: not a name that failed to resolve.
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toMatch(/^HTTP\/1\.1 403[\s\S]*'bad\.example\.com' is denied by the policy/);
    expect(refusals[1]).toMatch(/^HTTP\/1\.1 403[\s\S]*'ok\.example\.com' on port 22 is not in the allowlist/);
  }, RUN_TIMEOUT_MS);

  it('applies no deny list under --updaterc, which observes every host', async () => {
    // Discovery records what a workflow reaches so it can be declared, and a
    // deny applied there would keep a host out of what it records. The
    // address is one the screen refuses, so nothing is looked up or dialled.
    fs.writeFileSync(path.join(checkout, '.localmostrc'), 'version: 1\nshared:\n  network:\n    deny:\n      - 10.0.0.1\n');
    const answers = await proxyAnswers(['10.0.0.1:22'], { updaterc: true, assumeYes: true });
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatch(/^HTTP\/1\.1 403[\s\S]*does not resolve to a routable address/);
    expect(answers[0]).not.toMatch(/denied by the policy/);
    expect(logs.join('\n')).toMatch(/Filesystem: .*not recorded/);
  }, RUN_TIMEOUT_MS);

  it('does not run discovery, which opens the network, without confirmation', async () => {
    await expect(runTest({ updaterc: true }, fakeVm().deps)).rejects.toThrow(/--yes/);
    expect(fs.existsSync(path.join(scratch, 'appdata', 'workspaces'))).toBe(false);
  }, RUN_TIMEOUT_MS);
});
