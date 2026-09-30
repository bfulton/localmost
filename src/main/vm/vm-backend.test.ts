/**
 * VmBackend's workers against a fake VmManager (contract §5.1, §5.3, §5.4).
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { DockerVmConfig } from '../config';
import type { DockerPolicy } from '../../shared/docker-policy';
import type { WorkerContext, WorkerDocker } from '../docker/docker-backend';
import { DockerFilterProxy } from '../docker/docker-filter-proxy';
import { GuestImage } from './guest-image';
import { repoKeyOf } from './paths';
import { VmBackend } from './vm-backend';
import type { AgentClient, ImagePuller, VmError, VmHandle, VmManager, VmReady, VmRequest, VmState, VmStopped } from './types';
import { shortTempDir, writeGuest } from '../test-utils/vm-fixtures';

const config: DockerVmConfig = {
  prewarm: false, cpus: 4, memoryMiB: 8192, maxRunning: 2, dataDiskGiB: 64, bootTimeoutSec: 60,
  cacheLimitGiB: 20, pullMaxGiB: 10, jobPullMaxGiB: 30, minFreeGiB: 20,
};

/** A VM whose life the test drives by hand. */
class FakeVm implements VmHandle {
  readonly dockerSocketPath: string;
  status: VmState = 'queued';
  failed: VmError | undefined;
  stops: string[] = [];
  readonly agentClient = { approveBinds: jest.fn(async () => undefined) } as unknown as AgentClient;
  private resolveReady!: (ready: VmReady) => void;
  private rejectReady!: (err: VmError) => void;
  private readonly readyPromise: Promise<VmReady>;

  constructor(readonly vmId: string, readonly request: VmRequest) {
    this.dockerSocketPath = `/data/vm/jobs/${vmId}/docker.sock`;
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.readyPromise.catch(() => {});
  }

  boot(): void {
    this.status = 'booting';
  }

  becomeReady(rosetta: VmReady['rosetta'] = 'ok'): void {
    this.status = 'ready';
    this.resolveReady({ docker: { version: '29.5.3', apiVersion: '1.54' }, rosetta, bootMs: 900 });
  }

  fail(stage: VmError['stage'], code: string, message: string): void {
    this.failed = Object.assign(new Error(message), { stage, code }) as VmError;
    this.status = 'failed';
    this.rejectReady(this.failed);
  }

  state(): VmState {
    return this.status;
  }
  ready(): Promise<VmReady> {
    return this.readyPromise;
  }
  agent(): AgentClient {
    return this.agentClient;
  }
  async stop(reason: string): Promise<void> {
    this.stops.push(reason);
    if (this.status !== 'failed') this.status = 'stopped';
  }
  stopped(): Promise<VmStopped> {
    return Promise.resolve({ reason: 'requested', synced: false });
  }
  failure(): VmError | undefined {
    return this.failed;
  }
}

class FakeManager implements VmManager {
  vms: FakeVm[] = [];
  claimed: string[] = [];
  start(req: VmRequest): VmHandle {
    // As DefaultVmManager: one spare at a time.
    const live = (v: FakeVm) => v.request.spare && !this.claimed.includes(v.vmId) && v.status !== 'stopped' && v.status !== 'failed';
    if (req.spare && this.vms.some(live)) throw new Error('there is already a spare Docker VM');
    const vm = new FakeVm(`${req.slot}-${(this.vms.length + 1).toString(16).padStart(12, '0')}`, req);
    this.vms.push(vm);
    return vm;
  }
  claimSpare(vmId: string): boolean {
    const vm = this.vms.find((v) => v.vmId === vmId);
    if (!vm || !vm.request.spare || vm.status === 'stopped' || vm.status === 'failed') return false;
    this.claimed.push(vmId);
    return true;
  }
  async sweep(): Promise<void> {}
  onResume(): void {}
  onMemoryPressure(): void {}
  async shutdownAll(): Promise<void> {}
}

const grants: DockerPolicy = { run: { images: ['alpine:3'] }, pull: { registries: ['docker.io'] } };

describe('VmBackend', () => {
  let root: string;
  let sandboxDir: string;
  let manager: FakeManager;
  let puller: { pull: jest.Mock };
  let refreshes: string[];
  let logs: Array<{ level: string; message: string }>;
  let proxyUrl: string;

  beforeEach(() => {
    root = shortTempDir();
    sandboxDir = path.join(root, 'runner', 'sandbox', '3-abcdef012345');
    fs.mkdirSync(path.join(sandboxDir, '_work'), { recursive: true });
    writeGuest(path.join(root, 'guest'));
    manager = new FakeManager();
    puller = {
      pull: jest.fn(async () => ({ manifestDigest: `sha256:${'a'.repeat(64)}`, configDigest: `sha256:${'b'.repeat(64)}`, platform: 'linux/arm64', source: 'registry' })),
    };
    refreshes = [];
    logs = [];
    proxyUrl = 'http://localmost:token1@127.0.0.1:50123';
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const backend = () =>
    new VmBackend({
      vmManager: manager,
      guest: new GuestImage(path.join(root, 'guest')),
      puller: puller as unknown as ImagePuller,
      cacheDisks: { scheduleRefresh: (repoKey, repository) => refreshes.push(`${repoKey} ${repository}`) },
      config: () => config,
    });

  const worker = (overrides: Partial<WorkerContext> = {}): WorkerDocker =>
    backend().forWorker({
      slot: 3,
      sandboxDir,
      sandboxId: '3-abcdef012345',
      shareNonce: 'n'.repeat(32),
      spawnRepository: 'Owner/Repo',
      proxy: () => ({ port: 50123, url: proxyUrl }),
      log: (entry) => logs.push(entry),
      ...overrides,
    });

  it('is the VM backend: no privileged, and its daemon goes with the worker', () => {
    const b = backend();
    expect([b.name, b.supportsPrivileged, b.disposable]).toEqual(['vm', false, true]);
    expect(b.workspaceMountRoot('/s/3', 'owner/repo')).toBe('/s/3/_work/repo/repo');
  });

  describe('bind', () => {
    it('never starts a VM for a policy with no docker grants', () => {
      const w = worker();
      w.bind('owner/repo', {});
      w.bind('owner/repo', { privileged: false });
      expect(manager.vms).toHaveLength(0);
      expect(w.running()).toBe(false);
    });

    it('starts one for a grant, with everything the VM needs and nothing the job chose', () => {
      const w = worker();
      w.bind('Owner/Repo', grants);
      expect(manager.vms).toHaveLength(1);
      expect(manager.vms[0].request).toEqual({
        mode: 'job',
        slot: 3,
        sandboxId: '3-abcdef012345',
        shareRealPath: `${fs.realpathSync(sandboxDir)}/_work`,
        shareNonce: 'n'.repeat(32),
        repository: 'Owner/Repo',
        repoKey: repoKeyOf('owner/repo'),
        proxyPort: 50123,
      });
      expect(logs).toContainEqual({ level: 'info', message: `Docker VM ${manager.vms[0].vmId} booting for Owner/Repo at the claim` });
    });

    it('starts one VM for a double bind of the same repository and policy', () => {
      const w = worker();
      w.bind('owner/repo', grants);
      w.bind('owner/repo', grants);
      w.bind('OWNER/REPO', grants);
      expect(manager.vms).toHaveLength(1);
    });

    it('replaces only the policy on a later bind, grants or none, and leaves the VM running', () => {
      const w = worker();
      w.bind('owner/repo', grants);
      manager.vms[0].becomeReady();
      w.bind('owner/repo', { build: {} });
      w.bind('owner/repo', {});
      expect(manager.vms).toHaveLength(1);
      expect(manager.vms[0].stops).toEqual([]);
    });

    it('boots nothing once release has started, a bind while stopping included', async () => {
      const w = worker();
      const releasing = w.release();
      w.bind('owner/repo', grants);
      await releasing;
      w.bind('owner/repo', grants);
      expect(manager.vms).toHaveLength(0);
      expect(await w.endpoint(10)).toEqual({ kind: 'none', reason: 'the job has ended' });
    });

    it('stops the VM on a bind for another repository, and boots no other', async () => {
      const w = worker();
      w.bind('owner/repo', grants);
      manager.vms[0].becomeReady();
      w.bind('other/repo', grants);
      w.bind('other/repo', grants);
      expect(manager.vms).toHaveLength(1);
      expect(manager.vms[0].stops).toEqual(['bound to another repository']);
      const endpoint = await w.endpoint(10);
      expect(endpoint.kind).toBe('none');
    });

    it('never boots a VM for a sandbox id that is not one', async () => {
      const w = worker({ sandboxId: '../x' });
      w.bind('owner/repo', grants);
      expect(manager.vms).toHaveLength(0);
      expect(await w.endpoint(10)).toMatchObject({ kind: 'none', reason: expect.stringMatching(/sandbox id/) });
    });
  });

  describe('the spare', () => {
    it('is booted for the spawn repository, and adopted by a claim for it', () => {
      const w = worker();
      w.prewarm();
      w.prewarm();
      expect(manager.vms).toHaveLength(1);
      expect(manager.vms[0].request).toMatchObject({ spare: true, repository: 'Owner/Repo' });
      w.bind('owner/repo', grants);
      expect(manager.vms).toHaveLength(1);
      expect(manager.claimed).toEqual([manager.vms[0].vmId]);
      expect(manager.vms[0].stops).toEqual([]);
    });

    it('is stopped, and a VM booted, when the claim is for another repository', () => {
      const w = worker();
      w.prewarm();
      w.bind('someone/else', grants);
      expect(manager.vms).toHaveLength(2);
      expect(manager.vms[0].stops).toHaveLength(1);
      expect(manager.vms[1].request).toMatchObject({ repository: 'someone/else' });
      expect(manager.vms[1].request.spare).toBeUndefined();
    });

    it('is stopped when the claimed job grants no Docker', () => {
      const w = worker();
      w.prewarm();
      w.bind('owner/repo', {});
      expect(manager.vms[0].stops).toHaveLength(1);
    });

    it('is not booted for a worker spawned for no repository', () => {
      const w = worker({ spawnRepository: undefined });
      w.prewarm();
      expect(manager.vms).toHaveLength(0);
    });

    it("is not booted for a second worker while the first's lives, which leaves that worker open", async () => {
      const first = worker();
      const second = worker({ slot: 4, sandboxId: '4-abcdef012345' });
      first.prewarm();
      second.prewarm();
      expect(manager.vms).toHaveLength(1);
      expect(logs).toContainEqual({ level: 'debug', message: 'No spare Docker VM for this worker: there is already a spare Docker VM' });
      // The second worker still boots its job's VM at the claim.
      second.bind('owner/repo', grants);
      expect(manager.vms).toHaveLength(2);
      expect(manager.vms[1].request).toMatchObject({ slot: 4, repository: 'owner/repo' });
      expect(manager.vms[1].request.spare).toBeUndefined();
    });

    it('is stopped when the claim leaves the socket closed', () => {
      const w = worker();
      w.prewarm();
      w.dropSpare('the claim is for someone/else, so the socket stays closed');
      w.dropSpare('again');
      expect(manager.vms[0].stops).toEqual(['the claim is for someone/else, so the socket stays closed']);
    });

    it('is replaced by a fresh boot when it was stopped before the claim', () => {
      const w = worker();
      w.prewarm();
      manager.vms[0].status = 'stopped';
      w.bind('owner/repo', grants);
      expect(manager.vms).toHaveLength(2);
    });
  });

  describe('endpoint', () => {
    it('is the VM\'s docker.sock once ready, after waiting for it', async () => {
      const w = worker();
      w.bind('owner/repo', grants);
      const vm = manager.vms[0];
      vm.boot();
      const waiting = w.endpoint(10_000);
      vm.becomeReady();
      expect(await waiting).toEqual({ kind: 'ready', socketPath: vm.dockerSocketPath });
      expect(w.running()).toBe(true);
    });

    it('is none with no capacity when the VM is still queued at the timeout', async () => {
      const w = worker();
      w.bind('owner/repo', grants);
      expect(await w.endpoint(50)).toEqual({ kind: 'none', reason: 'no Docker VM capacity' });
    });

    it('is none when the VM is still booting at the timeout', async () => {
      const w = worker();
      w.bind('owner/repo', grants);
      manager.vms[0].boot();
      expect(await w.endpoint(50)).toEqual({ kind: 'none', reason: "the job's Docker VM did not start within 0s" });
    });

    it('is none with the stage and code of a failed boot, and never retries', async () => {
      const w = worker();
      w.bind('owner/repo', grants);
      manager.vms[0].fail('nonce', 'E_NONCE', "the guest did not read the share's nonce back");
      const endpoint = await w.endpoint(1000);
      expect(endpoint).toEqual({
        kind: 'none',
        reason: "the job's Docker VM failed to start (nonce, E_NONCE): the guest did not read the share's nonce back",
      });
      w.bind('owner/repo', grants);
      expect(manager.vms).toHaveLength(1);
    });

    it('is none for a VM that died once ready', async () => {
      const w = worker();
      w.bind('owner/repo', grants);
      manager.vms[0].becomeReady();
      manager.vms[0].failed = Object.assign(new Error("the job's Docker VM stopped unexpectedly"), { stage: 'running', code: 'E_HELPER_KILLED' }) as VmError;
      manager.vms[0].status = 'failed';
      expect(await w.endpoint(10)).toEqual({ kind: 'none', reason: "the job's Docker VM stopped unexpectedly" });
      expect(w.running()).toBe(false);
    });

    it('is none, saying why, for a job with no grants', async () => {
      const w = worker();
      w.bind('owner/repo', {});
      expect(await w.endpoint(10)).toMatchObject({ kind: 'none', reason: expect.stringMatching(/grants no Docker actions/) });
    });
  });

  describe('containerProxyEnv', () => {
    it("is the worker's current proxy, at the relay address in the VM, and nothing without a VM", () => {
      const w = worker();
      expect(w.containerProxyEnv()).toEqual({});
      w.bind('owner/repo', grants);
      manager.vms[0].becomeReady();
      const relayed = 'http://localmost:token1@198.18.0.1:3128';
      expect(w.containerProxyEnv()).toEqual({
        HTTP_PROXY: relayed, HTTPS_PROXY: relayed, http_proxy: relayed, https_proxy: relayed,
        NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
      });
      // The token rotates; the next container gets the one current then.
      proxyUrl = 'http://localmost:token2@127.0.0.1:50123';
      expect(w.containerProxyEnv().HTTP_PROXY).toBe('http://localmost:token2@198.18.0.1:3128');
    });
  });

  describe('pull and approveBinds', () => {
    it("pulls into the VM with its Rosetta state, logging where the image came from", async () => {
      const w = worker();
      w.bind('Owner/Repo', grants);
      manager.vms[0].becomeReady('absent');
      await new Promise((resolve) => setImmediate(resolve));
      const progress = jest.fn();
      const signal = new AbortController().signal;
      await w.pull({ registry: 'docker.io', repositoryPath: 'library/alpine', tag: '3' }, progress, signal);
      expect(puller.pull).toHaveBeenCalledWith(expect.objectContaining({
        repository: 'Owner/Repo',
        request: { registry: 'docker.io', repositoryPath: 'library/alpine', tag: '3' },
        rosetta: 'absent',
        dockerSocketPath: manager.vms[0].dockerSocketPath,
        onProgress: progress,
        signal,
      }));
      expect(logs).toContainEqual({
        level: 'info',
        message: `pulled docker.io/library/alpine:3 (sha256:${'a'.repeat(64)}, linux/arm64) on the Mac; loaded into VM ${manager.vms[0].vmId}`,
      });
      puller.pull.mockImplementationOnce(async () => ({ manifestDigest: `sha256:${'c'.repeat(64)}`, configDigest: `sha256:${'d'.repeat(64)}`, platform: 'linux/arm64', source: 'vm' }));
      await w.pull({ registry: 'docker.io', repositoryPath: 'library/alpine', digest: `sha256:${'c'.repeat(64)}` }, progress, signal);
      expect(logs.map((l) => l.message)).toContain(
        `pulled docker.io/library/alpine@sha256:${'c'.repeat(64)} (sha256:${'c'.repeat(64)}, linux/arm64) on the Mac; already in VM ${manager.vms[0].vmId}`
      );
    });

    it('remembers, for the job, the image each pull by digest resolved to, and nothing a tag pull resolved', async () => {
      const w = worker();
      w.bind('owner/repo', grants);
      manager.vms[0].becomeReady();
      const signal = new AbortController().signal;
      const digest = `sha256:${'c'.repeat(64)}`;
      const byDigest = { registry: 'docker.io', repositoryPath: 'library/alpine', digest };
      expect(w.imageForDigest(byDigest)).toBeUndefined();
      await w.pull({ registry: 'docker.io', repositoryPath: 'library/alpine', tag: '3' }, () => {}, signal);
      expect(w.imageForDigest({ registry: 'docker.io', repositoryPath: 'library/alpine', tag: '3' })).toBeUndefined();
      await w.pull(byDigest, () => {}, signal);
      expect(w.imageForDigest(byDigest)).toBe(`sha256:${'b'.repeat(64)}`);
      // The key is the whole reference: another repository or digest is not it.
      expect(w.imageForDigest({ ...byDigest, repositoryPath: 'library/busybox' })).toBeUndefined();
      expect(w.imageForDigest({ ...byDigest, registry: 'ghcr.io' })).toBeUndefined();
      expect(w.imageForDigest({ ...byDigest, digest: `sha256:${'e'.repeat(64)}` })).toBeUndefined();
    });

    it('records no image for a digest pull whose config digest is not one', async () => {
      puller.pull.mockImplementation(async () => ({ manifestDigest: `sha256:${'a'.repeat(64)}`, configDigest: 'sha256:../../x', platform: 'linux/arm64', source: 'registry' }));
      const w = worker();
      w.bind('owner/repo', grants);
      manager.vms[0].becomeReady();
      const byDigest = { registry: 'docker.io', repositoryPath: 'library/alpine', digest: `sha256:${'c'.repeat(64)}` };
      await w.pull(byDigest, () => {}, new AbortController().signal);
      expect(w.imageForDigest(byDigest)).toBeUndefined();
    });

    it("hands approvals to the VM's agent, and refuses them with no VM ready", async () => {
      const w = worker();
      await expect(w.approveBinds('f'.repeat(64), [])).rejects.toThrow(/not ready/);
      w.bind('owner/repo', grants);
      manager.vms[0].becomeReady();
      const binds = [{ source: '/s/_work/r/r/data', destination: '/data', readOnly: true }];
      await w.approveBinds('f'.repeat(64), binds);
      expect(manager.vms[0].agentClient.approveBinds).toHaveBeenCalledWith('f'.repeat(64), binds);
    });
  });

  describe('release', () => {
    it('stops the VM once however often it is called, and schedules a refresh when something new was pulled', async () => {
      const w = worker();
      w.bind('Owner/Repo', grants);
      manager.vms[0].becomeReady();
      await w.pull({ registry: 'docker.io', repositoryPath: 'library/alpine', tag: '3' }, () => {}, new AbortController().signal);
      await Promise.all([w.release(), w.release()]);
      await w.release();
      expect(manager.vms[0].stops).toEqual(['the job ended']);
      expect(refreshes).toEqual([`${repoKeyOf('owner/repo')} Owner/Repo`]);
      expect(logs.map((l) => l.message)).toContain(`Docker VM ${manager.vms[0].vmId} released: the job ended`);
    });

    it('schedules no refresh when every pull was already in the VM, or nothing was pulled', async () => {
      puller.pull.mockImplementation(async () => ({ manifestDigest: `sha256:${'c'.repeat(64)}`, configDigest: `sha256:${'d'.repeat(64)}`, platform: 'linux/arm64', source: 'vm' }));
      const w = worker();
      w.bind('owner/repo', grants);
      manager.vms[0].becomeReady();
      await w.pull({ registry: 'docker.io', repositoryPath: 'library/alpine', tag: '3' }, () => {}, new AbortController().signal);
      await w.release();
      const idle = worker();
      idle.bind('owner/repo', {});
      await idle.release();
      expect(refreshes).toEqual([]);
    });

    it('stops the spare too', async () => {
      const w = worker();
      w.prewarm();
      await w.release();
      expect(manager.vms[0].stops).toEqual(['the worker exited']);
    });
  });

  describe('the baseline', () => {
    it('is exactly the §5.3 answers, from the guest manifest and the VM size', () => {
      const w = worker();
      expect(w.baseline('/_ping')).toEqual({
        status: 200,
        headers: {
          'Api-Version': '1.54',
          Ostype: 'linux',
          'Docker-Experimental': 'false',
          'Builder-Version': '1',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body: 'OK',
      });
      expect(w.baseline('/version')).toEqual({
        status: 200,
        headers: { 'Api-Version': '1.54', Ostype: 'linux', 'Docker-Experimental': 'false', 'Content-Type': 'application/json' },
        body: {
          Version: '29.5.3',
          ApiVersion: '1.54',
          MinAPIVersion: '1.24',
          Os: 'linux',
          Arch: 'arm64',
          KernelVersion: '6.18.54-0-virt',
          Components: [{ Name: 'Engine', Version: '29.5.3' }],
        },
      });
      expect(w.baseline('/info')).toEqual({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          ServerVersion: '29.5.3',
          OSType: 'linux',
          Architecture: 'aarch64',
          OperatingSystem: 'localmost guest (Alpine Linux v3.24)',
          KernelVersion: '6.18.54-0-virt',
          Driver: 'overlay2',
          CgroupVersion: '2',
          SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'],
          NCPU: 4,
          MemTotal: 8192 * 1024 * 1024,
        },
      });
    });

    it('is a 503 that says why when the guest cannot be used', () => {
      fs.rmSync(path.join(root, 'guest', 'manifest.json'));
      expect(worker().baseline('/_ping')).toMatchObject({ status: 503, body: { message: expect.stringMatching(/guest/) } });
    });

    it('matches, through the filter, what a job sees forwarded from a VM booted from the same manifest', async () => {
      // A job's client must not be able to tell the two apart: the same
      // status, the headers it reads, and the same value in every field the
      // synthesised answer has.
      const recorded = JSON.parse(fs.readFileSync(path.join(__dirname, 'testdata', 'forwarded-baseline.json'), 'utf-8'));
      const w = worker();
      const proxy = new DockerFilterProxy({ backend: backend(), worker: w });
      const sock = path.join(root, 'd.sock');
      await proxy.start(sock);
      try {
        const get = (p: string) =>
          new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
            const req = http.request({ socketPath: sock, path: p, agent: false }, (res) => {
              let body = '';
              res.on('data', (c: Buffer) => (body += c.toString()));
              res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
            });
            req.on('error', reject);
            req.end();
          });
        const ping = await get('/_ping');
        expect(ping.status).toBe(recorded.ping.status);
        expect(ping.body).toBe(recorded.ping.body);
        for (const header of ['api-version', 'builder-version', 'ostype', 'docker-experimental', 'content-type', 'cache-control', 'pragma']) {
          expect([header, ping.headers[header]]).toEqual([header, recorded.ping.headers[header]]);
        }
        const version = await get('/v1.45/version');
        expect(version.status).toBe(recorded.version.status);
        for (const header of ['api-version', 'ostype', 'docker-experimental', 'content-type']) {
          expect([header, version.headers[header]]).toEqual([header, recorded.version.headers[header]]);
        }
        const synthesisedVersion = JSON.parse(version.body) as Record<string, unknown>;
        for (const [field, value] of Object.entries(synthesisedVersion)) {
          if (field === 'Components') continue;
          expect([field, value]).toEqual([field, recorded.version.body[field]]);
        }
        expect(synthesisedVersion.Components).toEqual([{ Name: 'Engine', Version: recorded.version.body.Components[0].Version }]);
        const info = await get('/v1.45/info');
        const synthesisedInfo = JSON.parse(info.body) as Record<string, unknown>;
        expect(Object.keys(synthesisedInfo).sort()).toEqual(Object.keys(recorded.info.body).sort());
        for (const [field, value] of Object.entries(synthesisedInfo)) {
          // The guest's own MemTotal is the configured size less what the kernel keeps.
          if (field === 'MemTotal') {
            expect(value).toBeGreaterThanOrEqual(recorded.info.body.MemTotal);
            expect(value).toBeLessThan(recorded.info.body.MemTotal * 1.05);
            continue;
          }
          expect([field, value]).toEqual([field, recorded.info.body[field]]);
        }
        expect(manager.vms).toHaveLength(0);
      } finally {
        await proxy.stop();
      }
    });
  });
});
