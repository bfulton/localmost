/**
 * The VM Docker backend: one Linux VM per job whose policy grants Docker,
 * booted at the claim and discarded with the worker (contract §5.1; the
 * design's decisions 1-2).
 *
 * Each worker's socket gets a VmWorker. It boots nothing until the claimed
 * job's policy is bound, and only if that policy grants a Docker action; a
 * repeated bind never boots a second VM (runner-manager binds at least twice
 * per job). Until a VM is ready the filter answers the baseline from the
 * guest's manifest, and requests wait for the VM up to the boot timeout. A
 * VM that fails is never retried for its job: the socket answers 503 with the
 * reason. Privileged stays refused (owner decision 2).
 */

import * as fs from 'fs';
import type { DockerVmConfig } from '../config';
import { hasDockerGrants, type DockerPolicy } from '../../shared/docker-policy';
import {
  runnerWorkspaceRoot,
  type ApprovedBind,
  type DockerBackend,
  type DockerProgress,
  type EndpointState,
  type PullRequest,
  type WorkerContext,
  type WorkerDocker,
} from '../docker/docker-backend';
import type { GuestImage } from './guest-image';
import { repoKeyOf, SANDBOX_ID_RE, SHARE_DIR_NAME } from './paths';
import type { CacheDisks, ImagePuller, VmHandle, VmManager, VmReady, VmRequest } from './types';

/** Where a container's proxy is, inside the VM: the relay to the worker's ProxyServer (§3.4). */
const RELAY_HOST = '198.18.0.1';
const RELAY_PORT = 3128;

/** An image id, as dockerd names a loaded image: the config digest. */
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;

/** A pull by digest's key: the reference as the puller normalized it, keyed by its digest alone. */
const digestKey = (req: PullRequest): string | undefined =>
  req.digest === undefined ? undefined : `${req.registry}/${req.repositoryPath}@${req.digest}`;

/** What a container never sends through the proxy. The job lists its own services itself. */
const NO_PROXY = 'localhost,127.0.0.1,::1';

export interface VmBackendOptions {
  vmManager: VmManager;
  guest: Pick<GuestImage, 'manifest'>;
  puller: ImagePuller;
  cacheDisks: Pick<CacheDisks, 'scheduleRefresh'>;
  config: () => DockerVmConfig;
  /** Injected for tests; defaults to fs.realpathSync. */
  realpath?: (p: string) => string;
}

/** GitHub compares repository names without regard to case, and so does this. */
const sameRepository = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

export class VmBackend implements DockerBackend {
  readonly name = 'vm';
  /** Owner decision 2: a privileged container reaches the VM's kernel, and stays refused. */
  readonly supportsPrivileged = false;
  /** The daemon goes with the worker, so nothing it made needs removing one by one. */
  readonly disposable = true;

  constructor(private readonly opts: VmBackendOptions) {}

  workspaceMountRoot(sandboxDir: string, repository?: string): string {
    return runnerWorkspaceRoot(sandboxDir, repository);
  }

  forWorker(ctx: WorkerContext): WorkerDocker {
    return new VmWorker(ctx, this.opts);
  }
}

class VmWorker implements WorkerDocker {
  private vm: VmHandle | null = null;
  private readyInfo: VmReady | null = null;
  private spare: VmHandle | null = null;
  /** The repository the VM was booted for. */
  private bootedFor: string | undefined;
  /** Why this worker has no VM, and never will: a bind for another repository, a bad sandbox. */
  private closed: string | null = null;
  private releasing: Promise<void> | null = null;
  /** A pull fetched something the repository's cache disk does not hold yet. */
  private pulledNew = false;
  /** What each pull by digest this job resolved to: `<registry>/<path>@<digest>` to the image id. */
  private readonly digestImages = new Map<string, string>();
  private readonly shareRealPath: string | null;

  constructor(private readonly ctx: WorkerContext, private readonly opts: VmBackendOptions) {
    // Resolved once, now, while the sandbox is the one the app made; the
    // helper and VmManager check the share again right before VZ starts.
    let share: string | null = null;
    try {
      share = `${(opts.realpath ?? fs.realpathSync)(ctx.sandboxDir)}/${SHARE_DIR_NAME}`;
    } catch (err) {
      this.closed = `the job's sandbox cannot be found: ${(err as Error).message}`;
    }
    this.shareRealPath = share;
    if (!SANDBOX_ID_RE.test(ctx.sandboxId)) this.closed = `the job's sandbox id ${JSON.stringify(ctx.sandboxId)} is not one`;
  }

  private log(level: 'debug' | 'info' | 'warn', message: string): void {
    this.ctx.log({ level, message });
  }

  private jobRequest(repository: string, spare = false): VmRequest {
    return {
      mode: 'job',
      slot: this.ctx.slot,
      sandboxId: this.ctx.sandboxId,
      shareRealPath: this.shareRealPath!,
      shareNonce: this.ctx.shareNonce,
      repository,
      repoKey: repoKeyOf(repository),
      proxyPort: this.ctx.proxy().port,
      ...(spare ? { spare: true } : {}),
    };
  }

  private boot(repository: string): VmHandle | null {
    try {
      const vm = this.opts.vmManager.start(this.jobRequest(repository));
      vm.ready().then(
        (ready) => {
          if (this.vm === vm) this.readyInfo = ready;
        },
        () => {}
      );
      return vm;
    } catch (err) {
      this.closed = `the job's Docker VM could not be started: ${(err as Error).message}`;
      this.log('warn', this.closed);
      return null;
    }
  }

  private stopSpare(reason: string): void {
    const spare = this.spare;
    this.spare = null;
    if (spare) void spare.stop(reason);
  }

  bind(repository: string, policy: DockerPolicy): void {
    if (this.releasing) return;
    if (this.vm) {
      if (!sameRepository(repository, this.bootedFor)) {
        // Not a path runner-manager takes - it binds only the repository the
        // worker was spawned for and claimed - so this is a mistake, and the
        // VM, with that other repository's cache and share, goes.
        this.closed = `the socket was bound to ${repository}, not ${this.bootedFor}, whose Docker VM it had`;
        this.log('warn', `${this.closed}; stopping it`);
        const vm = this.vm;
        this.vm = null;
        this.readyInfo = null;
        void vm.stop('bound to another repository');
      }
      // Otherwise only the policy changes, which the filter holds.
      return;
    }
    if (this.closed || !hasDockerGrants(policy)) {
      // A claim that grants no Docker: the spare, if any, is of no use.
      if (this.spare && !hasDockerGrants(policy)) this.stopSpare('the claimed job grants no Docker');
      return;
    }
    const spare = this.spare;
    this.spare = null;
    if (spare && sameRepository(repository, this.ctx.spawnRepository) && this.opts.vmManager.claimSpare(spare.vmId)) {
      this.vm = spare;
      spare.ready().then((ready) => {
        if (this.vm === spare) this.readyInfo = ready;
      }, () => {});
      this.log('info', `Docker VM ${spare.vmId} (the spare) is the job's, for ${repository}`);
    } else {
      if (spare) void spare.stop(`the claim is for ${repository}, not the repository it was booted for`);
      this.vm = this.boot(repository);
      if (this.vm) this.log('info', `Docker VM ${this.vm.vmId} booting for ${repository} at the claim`);
    }
    this.bootedFor = repository;
  }

  prewarm(): void {
    if (this.releasing || this.closed || this.vm || this.spare || !this.ctx.spawnRepository) return;
    try {
      // Not through boot(): a spare refused - there is one already, for
      // another worker - leaves this worker as it was, open for its claim.
      this.spare = this.opts.vmManager.start(this.jobRequest(this.ctx.spawnRepository, true));
    } catch (err) {
      this.log('debug', `No spare Docker VM for this worker: ${(err as Error).message}`);
      return;
    }
    this.log('debug', `Docker VM ${this.spare.vmId} booting as the spare for ${this.ctx.spawnRepository}`);
  }

  dropSpare(reason: string): void {
    this.stopSpare(reason);
  }

  /** Why a VM that failed failed, as the job's 503 says it. */
  private failureReason(vm: VmHandle): string {
    const failure = vm.failure();
    if (!failure) return "the job's Docker VM stopped";
    if (failure.stage === 'running') return failure.message;
    return `the job's Docker VM failed to start (${failure.stage}, ${failure.code}): ${failure.message}`;
  }

  async endpoint(timeoutMs: number): Promise<EndpointState> {
    if (this.releasing) return { kind: 'none', reason: 'the job has ended' };
    if (this.closed) return { kind: 'none', reason: this.closed };
    const vm = this.vm;
    if (!vm) return { kind: 'none', reason: "this job's docker policy grants no Docker actions, so it has no Docker VM" };
    switch (vm.state()) {
      case 'ready':
        return { kind: 'ready', socketPath: vm.dockerSocketPath };
      case 'failed':
        return { kind: 'none', reason: this.failureReason(vm) };
      case 'stopping':
      case 'stopped':
        return { kind: 'none', reason: "the job's Docker VM stopped" };
      default:
        break;
    }
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      vm.ready().then(
        () => 'ready' as const,
        () => 'failed' as const
      ),
      new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), timeoutMs))),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === 'ready' && vm.state() === 'ready') return { kind: 'ready', socketPath: vm.dockerSocketPath };
    if (outcome === 'timeout') {
      return {
        kind: 'none',
        reason:
          vm.state() === 'queued'
            ? 'no Docker VM capacity'
            : `the job's Docker VM did not start within ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    return { kind: 'none', reason: vm.state() === 'failed' ? this.failureReason(vm) : "the job's Docker VM stopped" };
  }

  running(): boolean {
    return this.vm?.state() === 'ready';
  }

  /** The answers of contract §5.3 "Baseline", from the guest the VM would boot. */
  baseline(path: '/_ping' | '/version' | '/info'): { status: number; headers: Record<string, string>; body: unknown } {
    let manifest;
    try {
      manifest = this.opts.guest.manifest();
    } catch (err) {
      return {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
        body: { message: `localmost's Docker VM guest cannot be used: ${(err as Error).message}` },
      };
    }
    const api = manifest.docker.apiVersion;
    const common = { 'Api-Version': api, Ostype: 'linux', 'Docker-Experimental': 'false' };
    if (path === '/_ping') {
      return {
        status: 200,
        headers: {
          ...common,
          // Never 2, which would steer the CLI to BuildKit, which the filter refuses.
          'Builder-Version': '1',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body: 'OK',
      };
    }
    if (path === '/version') {
      return {
        status: 200,
        headers: { ...common, 'Content-Type': 'application/json' },
        body: {
          Version: manifest.docker.engine,
          ApiVersion: api,
          MinAPIVersion: manifest.docker.minApiVersion,
          Os: 'linux',
          Arch: 'arm64',
          KernelVersion: manifest.baseline.KernelVersion,
          // No Experimental: dockerd omits it when false (omitempty), and
          // the answer must read as the forwarded one does.
          Components: [{ Name: 'Engine', Version: manifest.docker.engine }],
        },
      };
    }
    const config = this.opts.config();
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { ...manifest.baseline, NCPU: config.cpus, MemTotal: config.memoryMiB * 1024 * 1024 },
    };
  }

  async pull(req: PullRequest, onProgress: (p: DockerProgress) => void, signal: AbortSignal): Promise<void> {
    const vm = this.vm;
    if (!vm || vm.state() !== 'ready' || !this.bootedFor) throw new Error("the job's Docker VM is not ready");
    const ready = this.readyInfo ?? (await vm.ready());
    const result = await this.opts.puller.pull({
      repository: this.bootedFor,
      request: req,
      rosetta: ready.rosetta,
      dockerSocketPath: vm.dockerSocketPath,
      onProgress,
      signal,
    });
    const ref = `${req.registry}/${req.repositoryPath}${req.digest ? `@${req.digest}` : `:${req.tag ?? 'latest'}`}`;
    // The load cannot record a repo digest, so dockerd finds this image only
    // by its id; the filter asks for it here (§5.3 "Digest references").
    const key = digestKey(req);
    if (key !== undefined && IMAGE_ID_RE.test(result.configDigest)) this.digestImages.set(key, result.configDigest);
    if (result.source === 'vm') {
      this.log('info', `pulled ${ref} (${result.manifestDigest}, ${result.platform}) on the Mac; already in VM ${vm.vmId}`);
    } else {
      this.pulledNew = true;
      this.log('info', `pulled ${ref} (${result.manifestDigest}, ${result.platform}) on the Mac; loaded into VM ${vm.vmId}`);
    }
  }

  imageForDigest(req: PullRequest): string | undefined {
    const key = digestKey(req);
    return key === undefined ? undefined : this.digestImages.get(key);
  }

  async approveBinds(containerId: string, binds: ApprovedBind[]): Promise<void> {
    const vm = this.vm;
    if (!vm || vm.state() !== 'ready') throw new Error("the job's Docker VM is not ready");
    await vm.agent().approveBinds(containerId, binds);
  }

  /**
   * The worker's proxy, as a container reaches it: the relay address in the
   * VM, with the proxy's user and token, which rotate at every start and
   * every exit, so the URL is read fresh each time.
   */
  containerProxyEnv(): Record<string, string> {
    if (!this.running()) return {};
    let proxy: URL;
    try {
      proxy = new URL(this.ctx.proxy().url);
    } catch {
      return {};
    }
    const credentials = proxy.username ? `${proxy.username}${proxy.password ? `:${proxy.password}` : ''}@` : '';
    const url = `http://${credentials}${RELAY_HOST}:${RELAY_PORT}`;
    return {
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      http_proxy: url,
      https_proxy: url,
      NO_PROXY,
      no_proxy: NO_PROXY,
    };
  }

  release(): Promise<void> {
    this.releasing ??= (async () => {
      const vm = this.vm;
      this.stopSpare('the worker exited');
      if (vm) {
        await vm.stop('the job ended');
        this.log('info', `Docker VM ${vm.vmId} released: the job ended`);
      }
      // What the job pulled from a registry is in the Mac's store; a refresh
      // loads it into the repository's cache disk for the next job.
      if (this.pulledNew && this.bootedFor) this.opts.cacheDisks.scheduleRefresh(repoKeyOf(this.bootedFor), this.bootedFor);
    })();
    return this.releasing;
  }
}
