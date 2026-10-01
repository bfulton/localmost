/**
 * The VM backend's shared declarations: the VM manager, the guest agent's
 * client, the image puller and the cache disks. Declarations only, so that
 * each piece can be built against the others before they exist.
 *
 * See docs/roadmap/vm-docker-backend-contract.md §3.4, §5.1, §6.4 and §6.5.
 */

import type { ApprovedBind, DockerProgress, PullRequest } from '../docker/docker-backend';

/** What the guest's Rosetta self-test found: `absent` when the VM was booted without it. */
export type RosettaState = 'ok' | 'absent' | 'broken';

export interface VmRequest {
  mode: 'job' | 'refresh';
  /** 1–99 for a job; 0 for a refresh. Refreshes queue behind every job boot at the admission gate. */
  slot: number;
  /** Job only. */
  sandboxId?: string;
  /** Job only: realpath(<sandbox>)/_work, checked as the helper checks it (§2.1). */
  shareRealPath?: string;
  /** Job only: what the guest must read back from the share's nonce file. */
  shareNonce?: string;
  repository: string;
  repoKey: string;
  /** Job only: the worker's ProxyServer port on 127.0.0.1. */
  proxyPort?: number;
  /**
   * Job only: booted ahead of a claim for the worker's spawn repository
   * (dockerVm.prewarm). Admitted after every job boot and only while memory
   * pressure is normal; stopped on wake and under pressure until claimed.
   */
  spare?: boolean;
}

/** How a VM ended, once its helper has exited. */
export interface VmStopped {
  /** `guest` (powered off), `requested`, or `error`, as the helper said; `killed` when it said nothing. */
  reason: 'guest' | 'requested' | 'error' | 'killed';
  /** Refresh mode: the data disk was F_FULLFSYNC'd after a clean guest stop, so it may be promoted. */
  synced: boolean;
}

export type VmState = 'queued' | 'booting' | 'ready' | 'stopping' | 'stopped' | 'failed';

/** What a VM reports once `configure` succeeded. */
export interface VmReady {
  docker: { version: string; apiVersion: string };
  rosetta: RosettaState;
  bootMs: number;
}

/**
 * Where a VM failed, named with the code in the job's warning (the design's
 * "VM boot failure"): waiting at the admission gate, preparing the data disk,
 * the helper (spawn, exit, VZ), the agent (silent or gone), `configure`, the
 * share nonce, or after it was ready.
 */
export type VmStage = 'admission' | 'disk' | 'helper' | 'agent' | 'configure' | 'nonce' | 'running';

/** The helper's error codes (§2.4). */
export type HelperErrorCode =
  | 'E_ARGS'
  | 'E_SHARE'
  | 'E_GUEST_IMAGE'
  | 'E_DISK'
  | 'E_VZ_CONFIG'
  | 'E_VZ_START'
  | 'E_SOCKET'
  | 'E_GUEST_ERROR'
  | 'E_SYNC';

/** The guest agent's error codes (§3.4). */
export type AgentErrorCode =
  | 'E_PROTO'
  | 'E_UNKNOWN_OP'
  | 'E_CONFIGURED'
  | 'E_NOT_CONFIGURED'
  | 'E_DISK'
  | 'E_SHARE_PATH'
  | 'E_SHARE_MOUNT'
  | 'E_DOCKERD'
  | 'E_SELFTEST'
  | 'E_BINDS';

/**
 * What VmHandle.ready() rejects with: an Error that also names the stage.
 * `code` is a HelperErrorCode or an AgentErrorCode, or one VmManager names
 * for a failure of its own (a timeout, a nonce mismatch). `message` may
 * carry guest text, stripped of control characters.
 */
export interface VmError extends Error {
  stage: VmStage;
  code: string;
}

export interface VmHandle {
  readonly vmId: string;
  readonly dockerSocketPath: string;
  state(): VmState;
  /** Resolves on configure success; rejects with a VmError. */
  ready(): Promise<VmReady>;
  agent(): AgentClient;
  stop(reason: string): Promise<void>;
  /**
   * Resolves once the helper has exited and the VM's directory is gone,
   * however the VM stopped, and never rejects. A refresh promotes its disk
   * only on `synced: true` (§6.5).
   */
  stopped(): Promise<VmStopped>;
  /** Why the VM failed, once state() is `failed`: at boot, or after it was ready. */
  failure(): VmError | undefined;
}

export interface VmManager {
  sweep(): Promise<void>;
  /** Admission-gated; never blocks the caller. */
  start(req: VmRequest): VmHandle;
  /**
   * Make a spare VM an ordinary job VM, so that waking or memory pressure no
   * longer stops it. False when it is no longer a live spare.
   */
  claimSpare(vmId: string): boolean;
  onResume(): void;
  onMemoryPressure(level: 'normal' | 'warn' | 'critical'): void;
  shutdownAll(): Promise<void>;
}

/** `hello` (§3.4). */
export interface AgentHello {
  agent: string;
  guestVersion: string;
  kernel: string;
  agentProtocol: 1;
}

/** `configure` (§3.4). `share` and `relay` are sent in job mode only. */
export interface AgentConfigureRequest {
  vmId: string;
  mode: 'job' | 'refresh';
  timeUnixMs: number;
  share?: { tag: 'work'; mountPath: string; nonceFile: '.localmost-share' };
  rosetta: boolean;
  relay?: { address: '198.18.0.1'; port: 3128; vsockPort: 3128 };
}

export interface AgentConfigureResult {
  docker: { version: string; apiVersion: string; minApiVersion: string };
  disk: 'formatted' | 'existing' | 'corrupt';
  /** Job mode: what the guest read from the share's nonce file, at most 64 characters. */
  nonce?: string;
  rosetta: RosettaState;
  selftest: {
    rules: boolean;
    internalNoRelay: boolean;
    internalForgedRejected: boolean;
    gatewayRejected: boolean;
    bridgeReachesRelay: boolean;
    /** A connection off the guest, forwarded or the guest's own, was reset at once. */
    outsideRejected: boolean;
  };
}

/** `status` (§3.4). */
export interface AgentStatus {
  dockerd: 'running' | 'exited';
  uptimeMs: number;
}

/**
 * The guest agent over the helper's agent.sock (§3.4): one connection,
 * requests in order, each answer schema-checked and bounded before it is
 * returned. A refusal rejects with the agent's code and message; the
 * message is guest text, stripped of control characters.
 */
export interface AgentClient {
  hello(): Promise<AgentHello>;
  /** Accepted once by the agent; a second answers E_CONFIGURED. */
  configure(req: AgentConfigureRequest): Promise<AgentConfigureResult>;
  /** `container` is the 64-hex id from the create answer; at most 64 binds. */
  approveBinds(container: string, binds: ApprovedBind[]): Promise<void>;
  setTime(unixMs: number): Promise<void>;
  status(): Promise<AgentStatus>;
  /** Answered before the agent stops dockerd, syncs and powers the guest off. */
  shutdown(): Promise<void>;
  close(): void;
}

export interface ImagePullOptions {
  /** owner/name: the cache key. */
  repository: string;
  request: PullRequest;
  rosetta: RosettaState;
  /** The VM's docker.sock. */
  dockerSocketPath: string;
  onProgress(p: DockerProgress): void;
  signal: AbortSignal;
}

export interface ImagePullResult {
  manifestDigest: string;
  configDigest: string;
  platform: string;
  /** Where the image came from: the registry, the Mac's store, or already in the VM. */
  source: 'registry' | 'store' | 'vm';
}

/** Pulls on the Mac, verifies, and loads into the job's VM (§6.4). */
export interface ImagePuller {
  pull(opts: ImagePullOptions): Promise<ImagePullResult>;
}

/** The per-repository golden data disks (§6.5). */
export interface CacheDisks {
  /** A clone of the golden disk (clonefile), or a new sparse file when there is none. */
  prepareJobDisk(repoKey: string, dest: string, sizeGiB: number): Promise<'clone' | 'blank'>;
  /**
   * A hint, for the log: what a refresh loads comes from refs.json, where the
   * puller records only public images. It gates nothing.
   */
  notePulled(repoKey: string, configDigest: string): void;
  /**
   * Debounced 60 s (and run at most 10 minutes after the first schedule),
   * one at a time per repository, and held back while on battery or under
   * memory pressure. `repository` (owner/name) is what StartRefreshVm is
   * given; it must be the one `repoKey` was made from.
   */
  scheduleRefresh(repoKey: string, repository: string): void;
  discard(repoKey: string, reason: 'corrupt' | 'dataFormat' | 'limit'): Promise<void>;
}

/** Injected into CacheDisks, so that it does not import VmManager (WP-D builds against a fake). */
export type StartRefreshVm = (req: { repository: string; repoKey: string }) => VmHandle;
