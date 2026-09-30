/**
 * A docker job end to end through the runner, on the VM backend, with the
 * fake helper (contract §5.4, §8).
 *
 * Real: RunnerManager, the filtering socket, VmBackend, VmManager,
 * HelperClient and AgentClient, the sandbox on disk with its share and nonce.
 * The helper is the fake, selected by LOCALMOST_VM_HELPER as an unpackaged
 * run selects it, and spawned directly rather than under sandbox-exec. Behind
 * it, a mock daemon. The worker is a mock process, and the job's docker
 * client is this test, speaking to the socket the worker was given.
 *
 * The sandbox is handed to the runner by a path relative to the test's
 * working directory: a job's own TMPDIR, deep in its sandbox, leaves too few
 * of a unix socket path's 104 bytes for <data>/runner/sandbox/<id>/docker.sock.
 */

jest.mock('./process-sandbox', () => ({
  spawnSandboxed: jest.fn(),
}));

// A sandbox of its own for every start, laid out as buildSandbox lays one out.
jest.mock('./runner-downloader', () => {
  const fs = jest.requireActual<typeof import('fs')>('fs');
  const path = jest.requireActual<typeof import('path')>('path');
  const crypto = jest.requireActual<typeof import('crypto')>('crypto');
  return {
    RunnerDownloader: jest.fn().mockImplementation(() => ({
      getToolCacheDir: jest.fn((t: string) => path.join('runner', 'caches', t, 'tool-cache')),
      getTargetCacheDir: jest.fn((t: string) => path.join('runner', 'caches', t)),
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

jest.mock('../shared/sandbox-reaper', () => ({
  reapMarkedProcessesAsync: jest.fn(async () => []),
  developerPython: jest.fn(async () => null),
}));

jest.mock('./runner-cleanup', () => ({
  processStartTime: jest.fn(() => 'START'),
  lookUpStartTime: jest.fn(() => 'START'),
  mayEscalate: jest.requireActual('./runner-cleanup').mayEscalate,
  markerHolders: jest.fn(async () => []),
  signalOrphanPids: jest.fn(async () => ({ signalled: false, remaining: [] })),
  parsePidRecord: jest.requireActual('./runner-cleanup').parsePidRecord,
}));

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { RunnerManager, RepoPolicyRuntime } from './runner-manager';
import { ProxyServer } from './proxy-server';
import { spawnSandboxed } from './process-sandbox';
import { GuestImage } from './vm/guest-image';
import { helperPath, HELPER_OVERRIDE_ENV } from './vm/paths';
import { DefaultVmManager } from './vm/vm-manager';
import { VmBackend } from './vm/vm-backend';
import type { DockerVmConfig } from './config';
import type { CacheDisks, ImagePuller } from './vm/types';
import type { LogEntry } from '../shared/types';
import { createMockProcess, RunnerManagerTestHelper } from './test-utils';
import { FAKE_HELPER, shortTempDir, writeGuest } from './test-utils/vm-fixtures';

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

  it('boots the VM at the claim, once, serves the job through it, and releases it when the worker exits', async () => {
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
    };
    const guest = new GuestImage(path.join(data, 'res', 'guest'));
    vmManager = new DefaultVmManager({
      dataDir: fs.realpathSync(data),
      resources: path.join(data, 'res'),
      helperPath,
      guest,
      config: () => config,
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
      onLog: (entry) => logs.push(entry),
      onStatusChange: () => {},
      onJobHistoryUpdate: () => {},
      dockerBackend: backend,
      getDockerVmConfig: () => config,
      getRepoPolicy,
      getJobTarget: () => ({ targetDisplayName: 'owner/repo', repository: 'owner/repo', githubSha: 'abc123', githubWorkflow: 'CI' }),
    });
    const helper = new RunnerManagerTestHelper(manager);
    const worker = createMockProcess(40000 + (process.pid % 1000));
    jest.mocked(spawnSandboxed).mockReturnValue(worker);

    expect(helperPath()).toBe(FAKE_HELPER);
    await helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubRepo: 'owner/repo', githubSha: 'abc123' });
    const options = jest.mocked(spawnSandboxed).mock.calls[0][2]!;
    const socket = options.dockerSocket as string;
    const env = options.env as NodeJS.ProcessEnv;
    expect(env.DOCKER_HOST).toBe(`unix://${socket}`);

    // Before the claim the socket answers the baseline, and nothing boots.
    const earlyPing = await request(socket, 'GET', '/_ping');
    expect(earlyPing).toEqual({ status: 200, body: 'OK' });
    expect(fs.existsSync(path.join(data, 'vm', 'jobs'))).toBe(false);

    // The claim: the worker's proxy sees acquirejob, and the policy is bound.
    const proxyOptions = jest.mocked(ProxyServer).mock.calls.at(-1)![0] as unknown as { onJobAcquired: (id: string) => Promise<void> };
    await proxyOptions.onJobAcquired('job-1');
    // And again at the "Running job" line, as every job does.
    worker.stdout!.emit('data', Buffer.from('Running job: build\n'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getRepoPolicy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // The job's docker client: the create waits for the VM and goes through it.
    const create = await request(socket, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' });
    expect(create.status).toBe(201);
    expect(JSON.parse(create.body).Id).toBe(CID);
    expect(daemonSeen).toContain('POST /v1.45/containers/create');
    expect(logs.some((l) => l.message.includes(`approve-binds ${CID} []`))).toBe(true);
    const pulled = await request(socket, 'POST', '/v1.45/images/create?fromImage=alpine&tag=3');
    expect(pulled.status).toBe(200);
    expect(pulls).toHaveLength(1);
    expect(daemonSeen.some((line) => line.includes('/images/create'))).toBe(false);

    const vmDirs = fs.readdirSync(path.join(data, 'vm', 'jobs'));
    expect(vmDirs).toHaveLength(1);
    const vmId = vmDirs[0];

    // The worker exits: its socket stops, and the VM goes with it.
    worker.emit('exit', 0, null);
    const deadline = Date.now() + 10_000;
    while (fs.existsSync(path.join(data, 'vm', 'jobs', vmId)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(path.join(data, 'vm', 'jobs', vmId))).toBe(false);

    const messages = logs.map((l) => l.message);
    const boot = messages.findIndex((m) => m.includes(`Docker VM ${vmId} booting for owner/repo at the claim`));
    const ready = messages.findIndex((m) => m.startsWith(`Docker VM ${vmId} ready in `));
    const released = messages.findIndex((m) => m.includes(`Docker VM ${vmId} released: the job ended`));
    expect(boot).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(boot);
    expect(released).toBeGreaterThan(ready);
    // One VM for the job, whatever the number of binds.
    expect(messages.filter((m) => /booting for owner\/repo at the claim/.test(m))).toHaveLength(1);
    expect(messages.some((m) => m.includes(`pulled docker.io/library/alpine:3 (sha256:${'1'.repeat(64)}, linux/arm64) on the Mac; loaded into VM ${vmId}`))).toBe(true);
  }, 60_000);

  it('uses the spare only for a claim from the repository the worker was spawned for', async () => {
    const guest = new GuestImage(path.join(data, 'res', 'guest'));
    const started: Array<{ spare?: boolean; repository: string }> = [];
    vmManager = new DefaultVmManager({
      dataDir: fs.realpathSync(data),
      resources: path.join(data, 'res'),
      helperPath,
      guest,
      config: () => config,
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
    vmManager.start = (req) => {
      started.push({ spare: req.spare, repository: req.repository });
      return start(req);
    };
    const backend = new VmBackend({
      vmManager,
      guest,
      puller: { pull: async () => { throw new Error('unused'); } },
      cacheDisks: { scheduleRefresh: () => {} },
      config: () => config,
    });
    const run = async (claimed: string) => {
      const manager = new RunnerManager({
        onLog: (entry) => logs.push(entry),
        onStatusChange: () => {},
        onJobHistoryUpdate: () => {},
        dockerBackend: backend,
        getDockerVmConfig: () => ({ ...config, prewarm: true }),
        getRepoPolicy: async () => ({ hosts: [], level: 'strict', readPaths: [], writePaths: [], docker: { run: { images: ['alpine:3'] } } }),
        getJobTarget: () => ({ targetDisplayName: claimed, repository: claimed, githubSha: 'abc123', githubWorkflow: 'CI' }),
      });
      const worker = createMockProcess(41000 + started.length);
      jest.mocked(spawnSandboxed).mockReturnValue(worker);
      await new RunnerManagerTestHelper(manager).spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubRepo: 'owner/repo', githubSha: 'abc123' });
      const proxyOptions = jest.mocked(ProxyServer).mock.calls.at(-1)![0] as unknown as { onJobAcquired: (id: string) => Promise<void> };
      await proxyOptions.onJobAcquired('job');
      return worker;
    };
    /** The worker exits, and with it its socket and VM. */
    const exit = async (worker: ReturnType<typeof createMockProcess>) => {
      worker.emit('exit', 0, null);
      const jobs = path.join(data, 'vm', 'jobs');
      const deadline = Date.now() + 10_000;
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
    // binds only the spawn repository), so the spare boots and is never
    // adopted - it is stopped with the worker.
    started.length = 0;
    const other = await run('someone/else');
    expect(started).toEqual([{ spare: true, repository: 'owner/repo' }]);
    expect(logs.filter((l) => /\(the spare\) is the job's/.test(l.message))).toHaveLength(1);
    await exit(other);
  }, 60_000);
});
