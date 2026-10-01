/**
 * The VM Docker backend: one Linux VM per job whose policy grants Docker,
 * booted at the job's first Docker request that needs a daemon and discarded
 * with the worker (contract §5.1; the design's decisions 1-2).
 *
 * Each worker's socket gets a VmWorker. The claim binds the job's repository
 * and policy and boots nothing: most jobs never use Docker, and one VM per
 * claimed job held memory and disk for every one of them. The first request
 * the filter permits beyond the baseline it answers itself (/_ping, /version,
 * /info, from the guest's manifest) boots the VM, once, only if the bound
 * policy grants a Docker action; every request that comes while it boots
 * waits for it, up to the boot timeout, and gets the same answer. A VM that
 * fails is never retried for its job: the socket answers 503 with the reason.
 * A job that never asks has no VM, no helper, and no disk. Privileged stays
 * refused (owner decision 2).
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
  /** The repository of the first bind with grants: the one the VM is, or will be, booted for. */
  private boundFor: string | undefined;
  /** Whether the latest bind's policy grants a Docker action; without, no request boots a VM. */
  private grants = false;
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
    if (this.boundFor !== undefined) {
      if (!this.closed && !sameRepository(repository, this.boundFor)) {
        // Not a path runner-manager takes - it binds only the repository the
        // worker was spawned for and claimed - so this is a mistake, and the
        // VM, with that other repository's cache and share, goes, or never
        // boots.
        const vm = this.vm;
        this.closed = `the socket was bound to ${repository}, not ${this.boundFor}, ${vm ? 'whose Docker VM it had' : 'for which it was bound first'}`;
        this.log('warn', vm ? `${this.closed}; stopping it` : this.closed);
        this.vm = null;
        this.readyInfo = null;
        if (vm) {
          // Its pulls' totals and the credentials they were given go with it.
          this.opts.puller.forget(vm.dockerSocketPath);
          void vm.stop('bound to another repository');
        }
      }
      // Otherwise only the policy changes, which the filter holds.
      this.grants = hasDockerGrants(policy);
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
      // Nothing boots here: the job's first request that needs the daemon does.
      this.log('debug', `the job's Docker VM boots at its first Docker request, for ${repository}`);
    }
    this.boundFor = repository;
    this.grants = true;
  }

  /**
   * The bound job's VM, booted now: the first request that needs the daemon.
   * Synchronous up to the start, so requests that arrive together boot one.
   */
  private bootForFirstRequest(): VmHandle | null {
    const repository = this.boundFor!;
    const vm = this.boot(repository);
    if (!vm) return null;
    this.vm = vm;
    this.log('info', `Docker VM ${vm.vmId} booting for ${repository}: the job's first Docker request`);
    return vm;
  }

  prewarm(): void {
    // Never once bound: a claimed job's VM is the spare it adopted, or the one
    // its first request boots.
    if (this.releasing || this.closed || this.vm || this.spare || this.boundFor !== undefined || !this.ctx.spawnRepository) return;
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

  async endpoint(timeoutMs: number, options: { boot?: boolean } = {}): Promise<EndpointState> {
    if (this.releasing) return { kind: 'none', reason: 'the job has ended' };
    if (this.closed) return { kind: 'none', reason: this.closed };
    let vm = this.vm;
    if (!vm) {
      if (this.boundFor === undefined || !this.grants) {
        return { kind: 'none', reason: "this job's docker policy grants no Docker actions, so it has no Docker VM" };
      }
      if (!options.boot) return { kind: 'none', reason: "the job's Docker VM was never started" };
      vm = this.bootForFirstRequest();
      if (!vm) return { kind: 'none', reason: this.closed ?? "the job's Docker VM could not be started" };
    }
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
    if (!vm || vm.state() !== 'ready' || !this.boundFor) throw new Error("the job's Docker VM is not ready");
    const ready = this.readyInfo ?? (await vm.ready());
    const result = await this.opts.puller.pull({
      repository: this.boundFor,
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

  /**
   * Worker exit. A job whose VM never booted - it made no Docker request -
   * has nothing to stop, sweep or refresh: no helper ran and no VM directory
   * or disk was made, and once this has started no request boots one.
   */
  release(): Promise<void> {
    this.releasing ??= (async () => {
      const vm = this.vm;
      this.stopSpare('the worker exited');
      if (vm) {
        try {
          await vm.stop('the job ended');
        } finally {
          // Its pulls' totals and the credentials they were given go with
          // it, though it failed to stop.
          this.opts.puller.forget(vm.dockerSocketPath);
        }
        this.log('info', `Docker VM ${vm.vmId} released: the job ended`);
      }
      // What the job pulled from a registry is in the Mac's store; a refresh
      // loads it into the repository's cache disk for the next job.
      if (this.pulledNew && this.boundFor) this.opts.cacheDisks.scheduleRefresh(repoKeyOf(this.boundFor), this.boundFor);
    })();
    return this.releasing;
  }
}
