/**
 * A docker job end to end through the runner, on the VM backend, with the
 * fake helper (contract §5.4, §8).
 *
 * Real: RunnerManager, the filtering socket, VmBackend, VmManager,
 * HelperClient and AgentClient, the sandbox on disk with its share and nonce.
 * The helper is the fake, selected by LOCALMOST_VM_HELPER as an unpackaged
 * run selects it, and spawned directly rather than under sandbox-exec. Behind
 * it, a mock daemon. The worker's macOS VM is the fake backend, and the job's
 * docker client is this test, speaking to the socket in the worker's sandbox,
 * where the relay into the VM will reach it.
 *
 * The sandbox is handed to the runner by a path relative to the test's
 * working directory: a job's own TMPDIR, deep in its sandbox, leaves too few
 * of a unix socket path's 104 bytes for <data>/runner/sandbox/<id>/docker.sock.
 */


// A sandbox of its own for every start, laid out as buildSandbox lays one out.
jest.mock('./runner-downloader', () => {
  const fs = jest.requireActual<typeof import('fs')>('fs');
  const path = jest.requireActual<typeof import('path')>('path');
  const crypto = jest.requireActual<typeof import('crypto')>('crypto');
  return {
    RunnerDownloader: jest.fn().mockImplementation(() => ({
      getConfigDir: jest.fn((i: number) => path.join('runner', 'config', String(i))),
      buildSandbox: jest.fn(async (instance: number) => {
        const sandbox = path.join('runner', 'sandbox', `${instance}-${crypto.randomBytes(6).toString('hex')}`);
        fs.mkdirSync(path.join(sandbox, '_work'), { recursive: true });
        fs.mkdirSync(path.join(sandbox, '.docker'));
        fs.writeFileSync(path.join(sandbox, 'run.sh'), '');
        fs.writeFileSync(path.join(sandbox, '.runner'), '{}');
        return sandbox;
      }),
      writeShareNonce: jest.fn((sandbox: string) => {
        const nonce = crypto.randomBytes(16).toString('hex');
        fs.writeFileSync(path.join(sandbox, '_work', '.localmost-share'), nonce, { flag: 'wx', mode: 0o600 });
        return nonce;
      }),
      removeSandbox: jest.fn(async () => undefined),
      isDownloaded: jest.fn(() => true),
      isConfigured: jest.fn(() => true),
      hasAnyProxyCredentials: jest.fn(() => true),
      copyProxyCredentials: jest.fn(async () => undefined),
      getInstalledVersion: jest.fn(() => '2.330.0'),
    })),
  };
});

// The worker's proxy: what the runner reads of it answers as a fresh one
// does, and the rest - policy, stats, tokens - is a no-op.
jest.mock('./proxy-server', () => ({
  ProxyServer: jest.fn().mockImplementation(() => {
    const known: Record<string, unknown> = {
      start: jest.fn(async () => 51234),
      stop: jest.fn(async () => undefined),
      getProxyUrl: jest.fn(() => 'http://localmost:tok@127.0.0.1:51234'),
      getPort: jest.fn(() => 51234),
      getStats: jest.fn(() => ({ allowedCount: 0, blockedCount: 0, blockedHosts: new Set<string>() })),
      getPolicyLevel: jest.fn(() => 'strict'),
    };
    // Not a thenable: an async function returns this, and a `then` would be awaited.
    return new Proxy(known, {
      get: (target, name: string) => (name in target || name === 'then' ? target[name] : (target[name] = jest.fn())),
    });
  }),
}));

// The app's settings, empty: never the real config.yaml. config.ts fixes its
// path when it is imported, before LOCALMOST_CONFIG_DIR is set below, so
// without this the runner read the operator's own - which a job, where this
// suite also runs, cannot read at all (EPERM).
jest.mock('./config', () => ({
  ...jest.requireActual<typeof import('./config')>('./config'),
  loadConfig: jest.fn(() => ({})),
}));


import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { RunnerManager, RepoPolicyRuntime } from './runner-manager';
import { ProxyServer } from './proxy-server';
import { GuestImage } from './vm/guest-image';
import { helperPath, HELPER_OVERRIDE_ENV } from './vm/paths';
import { DefaultVmManager } from './vm/vm-manager';
import { VmBackend } from './vm/vm-backend';
import type { DockerVmConfig } from './config';
import type { CacheDisks, ImagePuller, VmHandle } from './vm/types';
import type { LogEntry } from '../shared/types';
import { createMockWorker, fakeIsolation, type FakeIsolation, RunnerManagerTestHelper } from './test-utils';
import { assertVmSocketsFit, FAKE_HELPER, shortTempDir, writeGuest } from './test-utils/vm-fixtures';

/** The macOS VM backend every manager here runs its workers on; a new one for each test. */
let isolation: FakeIsolation;
beforeEach(() => {
  isolation = fakeIsolation();
});

const config: DockerVmConfig = {
  prewarm: false, cpus: 1, memoryMiB: 1024, maxRunning: 2, dataDiskGiB: 64, bootTimeoutSec: 30,
  cacheLimitGiB: 20, pullMaxGiB: 10, jobPullMaxGiB: 30, minFreeGiB: 20,
};
const CID = 'e'.repeat(64);

interface Reply { status: number; body: string }
const request = (socketPath: string, method: string, p: string, body?: unknown): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, method, path: p, agent: false, headers: body !== undefined ? { 'content-type': 'application/json' } : {} },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode!, body: text }));
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });

/** Poll until `check` holds, for as long as a loaded machine may need. */
async function until(check: () => boolean, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('a docker job on the VM backend, through the runner', () => {
  let data: string;
  let previousCwd: string;
  const saved: Record<string, string | undefined> = {};
  let daemon: http.Server;
  let daemonSeen: string[];
  let logs: LogEntry[];
  let vmManager: DefaultVmManager;

  beforeEach(async () => {
    data = shortTempDir();
    assertVmSocketsFit(data);
    previousCwd = process.cwd();
    process.chdir(data);
    for (const name of ['LOCALMOST_CONFIG_DIR', HELPER_OVERRIDE_ENV]) saved[name] = process.env[name];
    process.env.LOCALMOST_CONFIG_DIR = data;
    process.env[HELPER_OVERRIDE_ENV] = FAKE_HELPER;
    writeGuest(path.join(data, 'res', 'guest'));
    // A registered target, whose credentials the downloader (mocked) copies.
    fs.mkdirSync(path.join(data, 'runner', 'proxies', 't1'), { recursive: true });
    daemonSeen = [];
    logs = [];
    daemon = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        daemonSeen.push(`${req.method} ${req.url}`);
        if (req.url?.includes('/containers/create')) {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Id: CID, Warnings: [] }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Api-Version': '1.54' });
          res.end('{}');
        }
      });
    });
    await new Promise<void>((resolve) => daemon.listen(path.join(data, 'd.sock'), resolve));
  });

  afterEach(async () => {
    await vmManager?.shutdownAll();
    await new Promise((resolve) => daemon.close(resolve));
    process.chdir(previousCwd);
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(data, { recursive: true, force: true });
  });

  it("boots the VM at the job's first Docker request, once, serves the job through it, and releases it when the worker exits", async () => {
    const pulls: string[] = [];
    const cacheDisks: CacheDisks = {
      prepareJobDisk: async (_repoKey, dest) => {
        fs.writeFileSync(dest, '', { flag: 'wx' });
        return 'blank';
      },
      notePulled: () => {},
      scheduleRefresh: () => {},
      discard: async () => {},
    };
    const puller: ImagePuller = {
      pull: async (opts) => {
        pulls.push(`${opts.request.registry}/${opts.request.repositoryPath}:${opts.request.tag} -> ${opts.dockerSocketPath}`);
        opts.onProgress({ status: 'Pulled' });
        return { manifestDigest: `sha256:${'1'.repeat(64)}`, configDigest: `sha256:${'2'.repeat(64)}`, platform: 'linux/arm64', source: 'registry' };
      },
      forget: () => {},
    };
    const guest = new GuestImage(path.join(data, 'res', 'guest'));
    vmManager = new DefaultVmManager({
      dataDir: fs.realpathSync(data),
      resources: path.join(data, 'res'),
      helperPath,
      guest,
      config: () => config,
      runnerSlots: () => 1,
      cacheDisks,
      log: (level, message) => logs.push({ level, message, timestamp: '' } as LogEntry),
      // The helper the environment selected, run directly with this node.
      spawnHelper: () => (helper, args, env) =>
        spawn(process.execPath, [helper, ...args], {
          env: { ...env, FAKE_DOCKERD_SOCKET: path.join(fs.realpathSync(data), 'd.sock') },
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      freeBytes: async () => 500 * 1024 ** 3,
      excludeFromBackup: async () => {},
    });
    const backend = new VmBackend({ vmManager, guest, puller, cacheDisks, config: () => config });
    const getRepoPolicy = jest.fn(async (): Promise<RepoPolicyRuntime> => ({
      hosts: [], level: 'strict', readPaths: [], writePaths: [],
      docker: { run: { images: ['alpine:3'], network: 'bridge' }, pull: { registries: ['docker.io'] } },
    }));
    const manager = new RunnerManager({
      isolation,
      onLog: (entry) => logs.push(entry),
      onStatusChange: () => {},
      onJobHistoryUpdate: () => {},
      dockerBackend: backend,
      getDockerVmConfig: () => config,
      getRepoPolicy,
      getJobTarget: () => ({ targetDisplayName: 'owner/repo', repository: 'owner/repo', githubSha: 'abc123', githubWorkflow: 'CI' }),
    });
    const helper = new RunnerManagerTestHelper(manager);
    const worker = createMockWorker(40000 + (process.pid % 1000));
    isolation.spawnWorker.mockResolvedValue(worker);

    expect(helperPath()).toBe(FAKE_HELPER);
    await helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubRepo: 'owner/repo', githubSha: 'abc123' });
    const [job] = isolation.spawnWorker.mock.calls[0];
    const socket = path.join(job.sandboxDir, 'docker.sock');

    // Before the claim the socket answers the baseline, and nothing boots.
    const earlyPing = await request(socket, 'GET', '/_ping');
    expect(earlyPing).toEqual({ status: 200, body: 'OK' });
    expect(fs.existsSync(path.join(data, 'vm', 'jobs'))).toBe(false);

    // The claim: the worker's proxy sees acquirejob, and the policy is bound.
    const proxyOptions = jest.mocked(ProxyServer).mock.calls.at(-1)![0] as unknown as { onJobAcquired: (id: string) => Promise<void> };
    await proxyOptions.onJobAcquired('job-1');
    // And again at the "Running job" line, as every job does.
    const claimLookups = getRepoPolicy.mock.calls.length;
    worker.emit('stdout', 'Running job: build');
    // That second application is fire-and-forget; wait for it, however loaded the machine.
    const policyDeadline = Date.now() + 20_000;
    while (getRepoPolicy.mock.calls.length <= claimLookups && Date.now() < policyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(getRepoPolicy.mock.calls.length).toBeGreaterThan(claimLookups);
    await new Promise((resolve) => setImmediate(resolve));
    // The claim boots nothing, and nor does the baseline every client asks first.
    expect((await request(socket, 'GET', '/v1.45/version')).status).toBe(200);
    expect(fs.existsSync(path.join(data, 'vm', 'jobs'))).toBe(false);
    expect(logs.some((l) => /booting/.test(l.message))).toBe(false);

    // The job's docker client: the create, its first request that needs the
    // daemon, boots the VM, waits for it and goes through it.
    const create = await request(socket, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' });
    expect(create.status).toBe(201);
    expect(JSON.parse(create.body).Id).toBe(CID);
    expect(daemonSeen).toContain('POST /v1.45/containers/create');
    // The helper's own log of the approval comes on its stderr, which may be
    // read after the agent's answer on the socket.
    await until(() => logs.some((l) => l.message.includes(`approve-binds ${CID} []`)), 'the approval in the helper log');
    const pulled = await request(socket, 'POST', '/v1.45/images/create?fromImage=alpine&tag=3');
    expect(pulled.status).toBe(200);
    expect(pulls).toHaveLength(1);
    expect(daemonSeen.some((line) => line.includes('/images/create'))).toBe(false);

    const vmDirs = fs.readdirSync(path.join(data, 'vm', 'jobs'));
    expect(vmDirs).toHaveLength(1);
    const vmId = vmDirs[0];

    // The worker exits: its socket stops, and the VM goes with it. The
    // release is logged once the VM has gone, a moment after its directory.
    worker.emit('exit', 0, null);
    await until(() => logs.some((l) => l.message.includes(`Docker VM ${vmId} released: the job ended`)), 'the release');
    expect(fs.existsSync(path.join(data, 'vm', 'jobs', vmId))).toBe(false);

    const messages = logs.map((l) => l.message);
    const boot = messages.findIndex((m) => m.includes(`Docker VM ${vmId} booting for owner/repo: the job's first Docker request`));
    const ready = messages.findIndex((m) => m.startsWith(`Docker VM ${vmId} ready in `));
    const released = messages.findIndex((m) => m.includes(`Docker VM ${vmId} released: the job ended`));
    expect(boot).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(boot);
    expect(released).toBeGreaterThan(ready);
    // One VM for the job, whatever the number of binds.
    expect(messages.filter((m) => /Docker VM .* booting/.test(m))).toHaveLength(1);
    expect(messages.some((m) => /at the claim/.test(m))).toBe(false);
    expect(messages.some((m) => m.includes(`pulled docker.io/library/alpine:3 (sha256:${'1'.repeat(64)}, linux/arm64) on the Mac; loaded into VM ${vmId}`))).toBe(true);
  }, 120_000);

  it('starts no VM, helper or disk for a docker job that never asks for the daemon', async () => {
    const helperSpawns: string[] = [];
    const disks: string[] = [];
    const guest = new GuestImage(path.join(data, 'res', 'guest'));
    const cacheDisks: CacheDisks = {
      prepareJobDisk: async (_repoKey, dest) => {
        disks.push(dest);
        fs.writeFileSync(dest, '', { flag: 'wx' });
        return 'blank';
      },
      notePulled: () => {},
      scheduleRefresh: () => {},
      discard: async () => {},
    };
    vmManager = new DefaultVmManager({
      dataDir: fs.realpathSync(data),
      runnerSlots: () => 1,
      resources: path.join(data, 'res'),
      helperPath,
      guest,
      config: () => config,
      cacheDisks,
      log: (level, message) => logs.push({ level, message, timestamp: '' } as LogEntry),
      spawnHelper: () => (h, args, env) => {
        helperSpawns.push(h);
        return spawn(process.execPath, [h, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      },
      freeBytes: async () => 500 * 1024 ** 3,
      excludeFromBackup: async () => {},
    });
    const backend = new VmBackend({
      vmManager,
      guest,
      puller: { pull: async () => { throw new Error('unused'); }, forget: () => {} },
      cacheDisks,
      config: () => config,
    });
    const manager = new RunnerManager({
      isolation,
      onLog: (entry) => logs.push(entry),
      onStatusChange: () => {},
      onJobHistoryUpdate: () => {},
      dockerBackend: backend,
      getDockerVmConfig: () => config,
      getRepoPolicy: async () => ({
        hosts: [], level: 'strict', readPaths: [], writePaths: [],
        docker: { run: { images: ['alpine:3'] }, pull: { registries: ['docker.io'] } },
      }),
      getJobTarget: () => ({ targetDisplayName: 'owner/repo', repository: 'owner/repo', githubSha: 'abc123', githubWorkflow: 'CI' }),
    });
    const worker = createMockWorker(42000 + (process.pid % 1000));
    isolation.spawnWorker.mockResolvedValue(worker);
    await new RunnerManagerTestHelper(manager).spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubRepo: 'owner/repo', githubSha: 'abc123' });
    const socket = path.join(isolation.spawnWorker.mock.calls.at(-1)![0].sandboxDir, 'docker.sock');
    const proxyOptions = jest.mocked(ProxyServer).mock.calls.at(-1)![0] as unknown as { onJobAcquired: (id: string) => Promise<void> };
    await proxyOptions.onJobAcquired('job-1');
    worker.emit('stdout', 'Running job: build');
    // The job's tools ask what the daemon is, and nothing more.
    expect((await request(socket, 'GET', '/_ping')).status).toBe(200);
    expect((await request(socket, 'GET', '/v1.45/version')).status).toBe(200);
    expect((await request(socket, 'GET', '/v1.45/info')).status).toBe(200);
    worker.emit('exit', 0, null);
    await until(() => !fs.existsSync(socket), 'the socket to stop');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(helperSpawns).toEqual([]);
    expect(disks).toEqual([]);
    expect(fs.existsSync(path.join(data, 'vm', 'jobs'))).toBe(false);
    expect(logs.some((l) => /Docker VM .*(booting|released)/.test(l.message))).toBe(false);
  }, 120_000);

  it('uses the spare only for a claim from the repository the worker was spawned for', async () => {
    const guest = new GuestImage(path.join(data, 'res', 'guest'));
    const started: Array<{ spare?: boolean; repository: string }> = [];
    vmManager = new DefaultVmManager({
      dataDir: fs.realpathSync(data),
      resources: path.join(data, 'res'),
      helperPath,
      guest,
      config: () => config,
      runnerSlots: () => 1,
      cacheDisks: {
        prepareJobDisk: async (_k, dest) => {
          fs.writeFileSync(dest, '');
          return 'blank' as const;
        },
        discard: async () => {},
      },
      log: (level, message) => logs.push({ level, message, timestamp: '' } as LogEntry),
      spawnHelper: () => (h, args, env) => spawn(process.execPath, [h, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] }),
      freeBytes: async () => 500 * 1024 ** 3,
      excludeFromBackup: async () => {},
    });
    const start = vmManager.start.bind(vmManager);
    const handles: VmHandle[] = [];
    vmManager.start = (req) => {
      started.push({ spare: req.spare, repository: req.repository });
      const handle = start(req);
      handles.push(handle);
      return handle;
    };
    const backend = new VmBackend({
      vmManager,
      guest,
      puller: { pull: async () => { throw new Error('unused'); }, forget: () => {} },
      cacheDisks: { scheduleRefresh: () => {} },
      config: () => config,
    });
    const run = async (claimed: string) => {
      const manager = new RunnerManager({
        isolation,
        onLog: (entry) => logs.push(entry),
        onStatusChange: () => {},
        onJobHistoryUpdate: () => {},
        dockerBackend: backend,
        getDockerVmConfig: () => ({ ...config, prewarm: true }),
        getRepoPolicy: async () => ({ hosts: [], level: 'strict', readPaths: [], writePaths: [], docker: { run: { images: ['alpine:3'] } } }),
        getJobTarget: () => ({ targetDisplayName: claimed, repository: claimed, githubSha: 'abc123', githubWorkflow: 'CI' }),
      });
      const worker = createMockWorker(41000 + started.length);
      isolation.spawnWorker.mockResolvedValue(worker);
      await new RunnerManagerTestHelper(manager).spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubRepo: 'owner/repo', githubSha: 'abc123' });
      const proxyOptions = jest.mocked(ProxyServer).mock.calls.at(-1)![0] as unknown as { onJobAcquired: (id: string) => Promise<void> };
      await proxyOptions.onJobAcquired('job');
      return worker;
    };
    /** The worker exits, and with it its socket and VM. */
    const exit = async (worker: ReturnType<typeof createMockWorker>) => {
      worker.emit('exit', 0, null);
      const jobs = path.join(data, 'vm', 'jobs');
      const deadline = Date.now() + 30_000;
      while (fs.existsSync(jobs) && fs.readdirSync(jobs).length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // A VM stopped before it was admitted never had a directory at all.
      expect(fs.existsSync(jobs) ? fs.readdirSync(jobs) : []).toEqual([]);
    };

    // The claim is for the repository the spare was booted for: it is the job's VM.
    const same = await run('owner/repo');
    expect(started).toEqual([{ spare: true, repository: 'owner/repo' }]);
    expect(logs.some((l) => /\(the spare\) is the job's, for owner\/repo/.test(l.message))).toBe(true);
    await exit(same);
    // A claim the runner routes elsewhere never opens the socket (the runner
    // binds only the spawn repository), so the spare is never adopted: it is
    // stopped at the claim, not left holding a slot until the worker exits.
    started.length = 0;
    const other = await run('someone/else');
    expect(started).toEqual([{ spare: true, repository: 'owner/repo' }]);
    const spare = handles.at(-1)!;
    await spare.stopped();
    // Stopping if it had been admitted, leaving the queue if not: either way, for the claim.
    expect(logs.some((l) => l.message.includes(`Docker VM ${spare.vmId}`) && l.message.includes('the claim is for someone/else, not owner/repo'))).toBe(true);
    expect(logs.filter((l) => /\(the spare\) is the job's/.test(l.message))).toHaveLength(1);
    await exit(other);
  }, 120_000);
});
