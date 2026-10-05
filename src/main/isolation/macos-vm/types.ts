/**
 * The macOS VM's interface with the rest of the app: the backend the runner
 * manager hands every job to, and the shapes it takes and returns. The VM is
 * the only place a job runs. Declarations only. See
 * docs/roadmap/macos-vm-jobs.md.
 */

import type { EventEmitter } from 'events';

/** Whether a mode can take a job on this Mac now, and why not. */
export interface IsolationAvailability {
  ok: boolean;
  /** Why not, in a sentence fit for a refusal or the Settings page. */
  reason?: string;
}

/**
 * What a VM is booted for: a key, and the two host ports on 127.0.0.1 its
 * relays lead to. A runner job's, or a `localmost test` run's.
 */
export interface VmLease {
  /**
   * Unique for the VM's life: the runner slot and job id, say. A second
   * prepare under a key that is still held is refused.
   */
  key: string;
  /** The worker's ProxyServer, or the test run's proxy: the guest's only way out. */
  proxyPort: number;
  /** The broker, which the worker's runner dials with its per-worker key; a test run's refuses every connection. */
  brokerPort: number;
}

/** One job, as the runner manager hands it to the backend. */
export interface IsolationJob extends VmLease {
  /**
   * The worker's sandbox, as buildSandbox made it and the runner manager
   * filled it: its .runner (pointed at the broker), .credentials and
   * .credentials_rsaparams are what the guest's runner gets, and nothing
   * else of it reaches the guest.
   */
  sandboxDir: string;
  /** The runner version the worker runs: the host's arc. */
  runnerVersion: string;
}

/** Signals a job's runner may be sent. */
export type JobSignal = 'SIGTERM' | 'SIGINT' | 'SIGKILL';

/**
 * The worker's runner, wherever it runs. It emits `stdout` and `stderr`
 * with one line each (already stripped of control characters), and `exit`
 * once with the exit code, or null and the signal that ended it.
 */
export interface WorkerHandle extends EventEmitter {
  /** The runner's pid in the guest, for logs only: it names no host process. */
  readonly pid: number;
  on(event: 'stdout' | 'stderr', listener: (line: string) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
}

export interface IsolationBackend {
  readonly type: 'macos-vm';
  /** Cheap and synchronous: from what the backend last learned. */
  available(): IsolationAvailability;
  /** How many macOS VMs this Mac runs at once: two, or one when its memory fits only one. */
  vmLimit(): number;
  /**
   * How many runner jobs may hold a VM now: the limit, and the slots the
   * golden image has saved states for, less the VMs a `localmost test` run
   * or the golden image itself holds.
   */
  jobCapacity(): number;
  /**
   * Everything before the runner: a VM slot (waiting for one if both are
   * taken, for at most `slotWaitMs` when given), the VM booted or restored,
   * and the guest prepared. Rejects with a reason; an abort while waiting or
   * booting releases what was taken.
   */
  prepare(job: VmLease, signal?: AbortSignal, slotWaitMs?: number): Promise<void>;
  /** Starts the runner in the prepared VM: `argv` is its arguments, `env` the worker's environment. */
  spawnWorker(job: IsolationJob, argv: string[], env: Record<string, string>): Promise<WorkerHandle>;
  signal(job: IsolationJob, signal: JobSignal): Promise<void>;
  /** Stops the VM and deletes its clone. Safe to call at any point, and twice. */
  release(job: VmLease): Promise<void>;
}
