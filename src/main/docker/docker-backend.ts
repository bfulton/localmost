/**
 * The daemon behind the filtering docker socket.
 *
 * The filter decides whether a request is permitted; the backend is where a
 * permitted request goes: a dockerd inside the worker's own VM, whose only
 * mount is the job's work folder (docs/roadmap/vm-docker-backend.md). There
 * is one backend, and no fallback to the operator's own daemon (owner
 * decision 3).
 */

import * as path from 'path';
import type { DockerPolicy } from '../../shared/docker-policy';

/**
 * Where a worker's Docker comes from. The app's is VmBackend, a VM per job;
 * noDockerBackend, below, has none. See
 * docs/roadmap/vm-docker-backend-contract.md §5.1.
 */
export interface DockerBackend {
  /** Human name for logs. */
  readonly name: string;
  /** Whether `privileged` may be granted. False: it reaches the VM's kernel (owner decision 2). */
  readonly supportsPrivileged: boolean;
  /** True when the daemon is thrown away with the worker, so no removal sweep is needed. */
  readonly disposable: boolean;
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
   * At the claim, with the bound policy. Boots nothing: the VM boots at the
   * job's first request that needs the daemon (endpoint with `boot`).
   * Idempotent: runner-manager calls it at least twice per job
   * (onJobAcquired, then the "Running job" line), and possibly on a previous
   * spawn's socket that is still stopping.
   *  - The first bind with hasDockerGrants(policy), while release() has not
   *    been called: records the repository the VM is for, and adopts the
   *    spare if it was booted for this repository, or else stops the spare.
   *  - Any later bind for the same repository: replaces the policy only.
   *  - A later bind without grants: replaces the policy (the filter then
   *    refuses everything but the baseline, and no request boots a VM) and
   *    leaves a running VM alone.
   *  - A bind for a different repository than the first: stops the VM, if
   *    one is running, and never boots another; the socket stays closed.
   *  - Any bind after release() has started: records nothing, boots nothing.
   */
  bind(repository: string, policy: DockerPolicy): void;
  /** When the worker is spawned and dockerVm.prewarm is on. */
  prewarm(): void;
  /**
   * At a claim that leaves the socket closed (a job of another repository
   * than the spawn's): the spare, if any, is of no use and is stopped.
   */
  dropSpare(reason: string): void;
  /**
   * The VM's docker.sock once ready. Waits while it boots, up to timeoutMs.
   * With `boot`, a request that needs the daemon: the first one boots the
   * bound job's VM, exactly once, and every one waits for it, then gets the
   * same answer, the boot's failure included. Without, only a VM that is
   * already there counts.
   */
  endpoint(timeoutMs: number, options?: { boot?: boolean }): Promise<EndpointState>;
  /** A VM is ready right now: the baseline is forwarded, not synthesised. */
  running(): boolean;
  /** The synthesised answers of contract §5.3 "Baseline". */
  baseline(path: '/_ping' | '/version' | '/info'): {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
  pull(req: PullRequest, onProgress: (p: DockerProgress) => void, signal: AbortSignal): Promise<void>;
  /**
   * The image id (`sha256:<config digest>`) a pull by digest in this job
   * resolved `<registry>/<repositoryPath>@<digest>` to, or undefined. The
   * VM's classic image store cannot find a loaded image by a digest
   * reference (contract §6.4 step 5), so the filter looks it up here.
   */
  imageForDigest(req: PullRequest): string | undefined;
  approveBinds(containerId: string, binds: ApprovedBind[]): Promise<void>;
  /** HTTP(S)_PROXY, http(s)_proxy and NO_PROXY for routable containers and builds; {} when no VM. */
  containerProxyEnv(): Record<string, string>;
  /** Worker exit: stop the VM, delete its directory, schedule a cache refresh. Idempotent. */
  release(): Promise<void>;
}

/**
 * The runner is configured with `--work _work`, so a job's checkout lives
 * under this subdir of its sandbox directory. Keep this aligned with the
 * workFolder in RunnerManager and buildSandbox.
 */
const RUNNER_WORK_FOLDER = '_work';

/**
 * The directory declared mount paths resolve against, for every backend: the
 * runner checks out into _work/<repo>/<repo>, which is GITHUB_WORKSPACE and
 * what a policy's `./` refers to. Rooting at _work made anything narrower
 * than `./` unmatchable, since ./tmp resolved to _work/tmp. Without a
 * repository, the work folder.
 */
export function runnerWorkspaceRoot(sandboxDir: string, repository?: string): string {
  const work = path.join(sandboxDir, RUNNER_WORK_FOLDER);
  const name = repository?.split('/').pop();
  return name ? path.join(work, name, name) : work;
}

/** Said when a request needs a daemon and there is none. */
export const NO_DAEMON_MESSAGE = 'no Docker daemon is available to this job';

/**
 * The backend of a RunnerManager made without one. The app always gives it
 * the VM backend; a runner that was not given one serves sockets that answer
 * every request with no daemon, never a fallback to another (owner decision
 * 3). Nothing ever runs behind them, so a stopped socket has nothing to
 * remove.
 */
export const noDockerBackend: DockerBackend = {
  name: 'none',
  supportsPrivileged: false,
  disposable: true,
  workspaceMountRoot: (sandboxDir, repository) => runnerWorkspaceRoot(sandboxDir, repository),
  forWorker: () => ({
    bind: () => {},
    prewarm: () => {},
    dropSpare: () => {},
    endpoint: async () => ({ kind: 'none', reason: NO_DAEMON_MESSAGE }),
    running: () => false,
    baseline: () => ({
      status: 503,
      headers: { 'Content-Type': 'application/json' },
      body: { message: NO_DAEMON_MESSAGE },
    }),
    pull: () => Promise.reject(new Error(NO_DAEMON_MESSAGE)),
    imageForDigest: () => undefined,
    approveBinds: () => Promise.reject(new Error(NO_DAEMON_MESSAGE)),
    containerProxyEnv: () => ({}),
    release: async () => {},
  }),
};

