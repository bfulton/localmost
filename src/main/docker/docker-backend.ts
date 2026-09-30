/**
 * The daemon behind the filtering docker socket.
 *
 * The filter decides whether a request is permitted; the backend is where a
 * permitted request goes. Keeping the two apart is what makes the isolation
 * progression a swap rather than a rewrite: stage 1 forwards to the operator's
 * own daemon, stage 2 to a dockerd inside a VM whose only mount is the job
 * workspace. See docs/superpowers/specs/2026-09-05-docker-isolation-design.md.
 */

import * as path from 'path';
import { resolveDockerEndpoint, DockerEndpoint } from '../../shared/docker-access';
import type { DockerPolicy } from '../../shared/docker-policy';

/**
 * A daemon backend with a VM per worker (stage 2, the VM Docker backend).
 * See docs/roadmap/vm-docker-backend-contract.md §5.1.
 */
export interface DockerBackend {
  readonly name: string;
  readonly supportsPrivileged: boolean;
  /** True when the daemon is thrown away with the worker, so no removal sweep is needed. */
  readonly disposable: boolean;
  /** As LegacyDockerBackend.workspaceMountRoot: a path below `sandboxDir`, never resolved. */
  workspaceMountRoot(sandboxDir: string, repository?: string): string;
  forWorker(ctx: WorkerContext): WorkerDocker;
}

/** What a backend is told about one worker when its docker socket is made. */
export interface WorkerContext {
  slot: number;
  /** As buildSandbox made it. The backend realpaths it once, at construction. */
  sandboxDir: string;
  sandboxId: string;
  /** Written by writeShareNonce before the worker started. */
  shareNonce: string;
  /** The repository the worker was spawned for, if any (for the spare). */
  spawnRepository?: string;
  /** The worker's ProxyServer, read when needed: its port and its token-bearing URL. */
  proxy(): { port: number; url: string };
  log(entry: { level: 'debug' | 'info' | 'warn'; message: string }): void;
}

/** Where the filter forwards a permitted request, or why there is nowhere. */
export type EndpointState = { kind: 'ready'; socketPath: string } | { kind: 'none'; reason: string };

/** Normalised as in contract §3.7 "Bind matching": source byte-exact, destination cleaned. */
export interface ApprovedBind {
  source: string;
  destination: string;
  readOnly: boolean;
}

/** One line of a pull's progress, in the shape the Docker CLI reads. */
export interface DockerProgress {
  status?: string;
  id?: string;
  progress?: string;
  progressDetail?: { current?: number; total?: number };
  error?: string;
  errorDetail?: { message: string };
}

/** An allowed `POST /images/create`, which the filter pulls on the Mac rather than forwarding. */
export interface PullRequest {
  /** e.g. docker.io */
  registry: string;
  /** e.g. library/alpine */
  repositoryPath: string;
  tag?: string;
  digest?: string;
  /** The request's ?platform=, if any. */
  platform?: string;
}

/** One worker's daemon: made by DockerBackend.forWorker, released when the worker exits. */
export interface WorkerDocker {
  /**
   * At the claim, with the bound policy. Idempotent: runner-manager calls it
   * at least twice per job (onJobAcquired, then the "Running job" line), and
   * possibly on a previous spawn's socket that is still stopping.
   *  - The first bind with hasDockerGrants(policy), while no VM exists and
   *    release() has not been called: adopts the spare if it was booted for
   *    this repository, otherwise stops the spare and boots a VM.
   *  - Any later bind for the same repository: replaces the policy only and
   *    never boots.
   *  - A later bind without grants: replaces the policy (the filter then
   *    refuses everything but the baseline) and leaves a running VM alone.
   *  - A bind for a different repository than the VM was booted for: stops
   *    the VM and never boots another; the socket stays closed, as today.
   *  - Any bind after release() has started: records nothing, boots nothing.
   */
  bind(repository: string, policy: DockerPolicy): void;
  /** When the worker is spawned and dockerVm.prewarm is on. */
  prewarm(): void;
  /** The VM's docker.sock once ready. Waits while it boots, up to timeoutMs. */
  endpoint(timeoutMs: number): Promise<EndpointState>;
  /** A VM is ready right now: the baseline is forwarded, not synthesised. */
  running(): boolean;
  /** The synthesised answers of contract §5.3 "Baseline". */
  baseline(path: '/_ping' | '/version' | '/info'): {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
  pull(req: PullRequest, onProgress: (p: DockerProgress) => void, signal: AbortSignal): Promise<void>;
  approveBinds(containerId: string, binds: ApprovedBind[]): Promise<void>;
  /** HTTP(S)_PROXY, http(s)_proxy and NO_PROXY for routable containers and builds; {} when no VM. */
  containerProxyEnv(): Record<string, string>;
  /** Worker exit: stop the VM, delete its directory, schedule a cache refresh. Idempotent. */
  release(): Promise<void>;
}

/**
 * The stage 1 shape, which DesktopBackend implements: one daemon for every
 * worker. It stays until the VM backend replaces DesktopBackend.
 */
export interface LegacyDockerBackend {
  /** Human name for logs. */
  readonly name: string;
  /** Whether `privileged` may be granted on this backend. Stage 1: false. */
  readonly supportsPrivileged: boolean;
  /** The daemon endpoint to forward approved requests to, or null when none. */
  resolveEndpoint(): DockerEndpoint | null;
  /** Absolute host path that job mounts must resolve inside (the job workspace). */
  /**
   * The directory declared mount paths resolve against: the repository
   * checkout when the socket is bound to one, since that is what `./` means to
   * whoever wrote the policy. Without a repository - a socket not yet bound -
   * the work folder is the widest honest answer.
   *
   * A path below `sandboxDir`, joined to it as written. The caller resolves
   * `sandboxDir` once and never resolves this: every directory below the
   * sandbox is the job's to replace with a link.
   */
  workspaceMountRoot(sandboxDir: string, repository?: string): string;
}

export interface DesktopBackendOptions {
  /** Endpoint lookup, injected for testing. Defaults to resolveDockerEndpoint. */
  resolve?: () => DockerEndpoint | null;
  /** The sandbox subdir the runner checks out into. Defaults to the runner's `_work`. */
  workspaceSubdir?: string;
}

/**
 * The runner is configured with `--work _work`, so a job's checkout lives
 * under this subdir of its sandbox directory. Keep this aligned with the
 * workFolder in RunnerManager and buildSandbox.
 */
const RUNNER_WORK_FOLDER = '_work';

/**
 * Stage 1: the operator's existing daemon, found exactly as the app finds it
 * today. Nothing contains a container that escapes this daemon, which is why
 * privileged can never be granted here.
 */
export class DesktopBackend implements LegacyDockerBackend {
  readonly name = 'docker-desktop';
  readonly supportsPrivileged = false;

  constructor(private readonly opts: DesktopBackendOptions = {}) {}

  resolveEndpoint(): DockerEndpoint | null {
    return this.opts.resolve ? this.opts.resolve() : resolveDockerEndpoint();
  }

  workspaceMountRoot(sandboxDir: string, repository?: string): string {
    const work = path.join(sandboxDir, this.opts.workspaceSubdir ?? RUNNER_WORK_FOLDER);
    // The runner checks out into _work/<repo>/<repo>, which is GITHUB_WORKSPACE
    // and what a policy's `./` refers to. Rooting at _work made anything
    // narrower than `./` unmatchable, since ./tmp resolved to _work/tmp.
    const name = repository?.split('/').pop();
    return name ? path.join(work, name, name) : work;
  }
}
