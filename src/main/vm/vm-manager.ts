/**
 * The Docker VMs: admission, boot, readiness, stop, the startup sweep, wake,
 * memory pressure and the free-space watch (contract §5.1, §5.4, §5.6; the
 * design's Edge cases).
 *
 * start() never blocks. A VM waits at the admission gate - at most
 * dockerVm.maxRunning run at once, jobs first in FIFO order, then the spare,
 * then cache refreshes - and then boots in stages, each of which can fail it
 * with a VmError naming the stage and a code: its data disk, the helper (the
 * share and guest checks Electron makes too, the spawn, VZ), the agent (silent
 * for 30 s), configure, and the share's nonce. A VM that failed is torn down
 * and never retried for its job. One that dies after it was ready is marked
 * failed too, never restarted: its containers and images are gone.
 *
 * Every path is built by vm/paths from ids; nothing a job controls reaches
 * here as a path.
 */

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { DockerVmConfig } from '../config';
import { UnixAgentClient, AgentClientError } from './agent-client';
import type { GuestImage } from './guest-image';
import { buildHelperProfile } from './helper-profile';
import { HelperClient, HelperExit, HelperSpawn, StartedEvent, sandboxedHelperSpawn } from './helper-client';
import { sanitizeGuestText } from './ndjson';
import {
  cacheFiles,
  newVmId,
  sandboxDirOf,
  sandboxFiles,
  vmDir,
  vmJobFiles,
  REPO_KEY_RE,
  VM_ID_RE,
} from './paths';
import type {
  AgentClient,
  CacheDisks,
  VmError,
  VmHandle,
  VmManager,
  VmReady,
  VmRequest,
  VmStage,
  VmState,
  VmStopped,
} from './types';

const GiB = 1024 ** 3;

/** A data disk smaller than this is no use, and the boot is refused. */
const MIN_DATA_DISK_BYTES = 8 * GiB;

/** How long the agent may stay silent after the VM started (the design's "agent silent for 30 s"). */
const AGENT_SILENT_MS = 30_000;
const AGENT_RETRY_MS = 100;

/** How often free space is checked while VMs run. */
const DISK_WATCH_MS = 10_000;

/** How long shutdownAll waits for every helper. */
const SHUTDOWN_ALL_MS = 10_000;

export type MemoryPressureLevel = 'normal' | 'warn' | 'critical';

export function vmError(stage: VmStage, code: string, message: string): VmError {
  return Object.assign(new Error(message), { stage, code, name: 'VmError' }) as VmError;
}

const isVmError = (err: unknown): err is VmError =>
  err instanceof Error && typeof (err as VmError).stage === 'string' && typeof (err as VmError).code === 'string';

/** Thrown inside a boot that stop() cancelled. */
class Cancelled extends Error {}

/**
 * Thrown when the guest found the repository's golden disk, cloned for this
 * VM, corrupt: the golden disk has been discarded, and the VM boots once more
 * on a blank disk (the design's "Cache disk corruption").
 */
class CorruptClone extends Error {}

export interface VmManagerOptions {
  /** <data>, realpathed. */
  dataDir: string;
  /** <resources>. */
  resources: string;
  /** helperPath(), read at each spawn and at the sweep. */
  helperPath: () => string;
  guest: Pick<GuestImage, 'verify'>;
  config: () => DockerVmConfig;
  cacheDisks: Pick<CacheDisks, 'prepareJobDisk' | 'discard'>;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Injected for tests: how a helper is spawned. The real one wraps it in sandbox-exec under helper.sb. */
  spawnHelper?: (profilePath: string, vmDir: string) => HelperSpawn;
  /** Free bytes on <data>'s volume. */
  freeBytes?: (dir: string) => Promise<number>;
  /** Bytes a sparse file has allocated. */
  allocatedBytes?: (file: string) => Promise<number>;
  /** A live process's executable, or null when there is no such process. processExecutableOf by default. */
  processExecutable?: (pid: number) => Promise<string | null>;
  /** For tests: the device a path is on, as stat(2) follows it. */
  deviceOf?: (p: string) => number;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Exclude <data>/vm from Time Machine when it is made. */
  excludeFromBackup?: (dir: string) => Promise<void>;
  /** For tests: how long the agent may stay silent, and the retry interval. */
  agentSilentMs?: number;
  agentRetryMs?: number;
  diskWatchMs?: number;
  /** For tests: the helper's grace between SIGTERM and SIGKILL. */
  killAfterMs?: number;
  /** For tests: how long shutdownAll waits before it kills what is left. */
  shutdownAllMs?: number;
}

const execFileText = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
  );

const defaultFreeBytes = async (dir: string): Promise<number> => {
  const stats = await fs.promises.statfs(dir);
  return stats.bavail * stats.bsize;
};

const defaultAllocatedBytes = async (file: string): Promise<number> => {
  try {
    return (await fs.promises.stat(file)).blocks * 512;
  } catch {
    return 0;
  }
};

/**
 * The file a live process runs, or null when there is none or it cannot be
 * told. Not `ps -o comm=`, which on macOS is the argv[0] the process gave
 * itself: anything can call itself the helper. lsof names the text vnode, the
 * executable itself, first among a process's txt entries (dyld follows).
 * macOS only, as the app is.
 */
export async function processExecutableOf(pid: number): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const out = await execFileText('/usr/sbin/lsof', ['-n', '-P', '-w', '-a', '-p', String(pid), '-d', 'txt', '-Fn']);
    const name = out.split('\n').find((line) => line.startsWith('n'));
    return name ? name.slice(1) : null;
  } catch {
    return null;
  }
}

const defaultExcludeFromBackup = async (dir: string): Promise<void> => {
  await execFileText('/usr/bin/tmutil', ['addexclusion', dir]);
};

class Vm implements VmHandle {
  readonly vmId: string;
  readonly dockerSocketPath: string;
  readonly files: ReturnType<typeof vmJobFiles>;
  status: VmState = 'queued';
  /** Where it is: the gate, then each boot stage in turn, which a stop or an unexpected error names. */
  stage: VmStage = 'admission';
  spare: boolean;
  helper: HelperClient | null = null;
  agentClient: UnixAgentClient | null = null;
  started: StartedEvent | undefined;
  failed: VmError | undefined;
  /** The data disk's apparent size, promised to this VM. */
  apparentBytes = 0;
  /** Whether the data disk is a clone of the repository's golden disk. */
  diskKind: 'clone' | 'blank' = 'blank';
  readonly abort = new AbortController();
  /**
   * The boot stage in progress. A stop abandons it, but it keeps running -
   * a mkdir, a clone - so the teardown waits for it before it removes the
   * VM's directory, or the stage would make it again afterwards.
   */
  inflight: Promise<unknown> = Promise.resolve();
  admit!: () => void;
  readonly admitted: Promise<void>;
  readonly readyPromise: Promise<VmReady>;
  resolveReady!: (ready: VmReady) => void;
  rejectReady!: (err: VmError) => void;
  readonly ended: Promise<VmStopped>;
  resolveEnded!: (stopped: VmStopped) => void;

  constructor(readonly request: VmRequest, dataDir: string, private readonly onStop: (vm: Vm, reason: string) => Promise<void>) {
    this.vmId = newVmId(request.slot);
    this.files = vmJobFiles(dataDir, this.vmId);
    this.dockerSocketPath = this.files.dockerSocket;
    this.spare = request.spare === true;
    this.admitted = new Promise((resolve) => (this.admit = resolve));
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A caller that never asks for ready() must not see an unhandled rejection.
    this.readyPromise.catch(() => {});
    this.ended = new Promise((resolve) => (this.resolveEnded = resolve));
  }

  state(): VmState {
    return this.status;
  }

  ready(): Promise<VmReady> {
    return this.readyPromise;
  }

  agent(): AgentClient {
    if (this.status !== 'ready' || !this.agentClient) throw new Error(`Docker VM ${this.vmId} is ${this.status}, not ready`);
    return this.agentClient;
  }

  stop(reason: string): Promise<void> {
    return this.onStop(this, reason);
  }

  stopped(): Promise<VmStopped> {
    return this.ended;
  }

  failure(): VmError | undefined {
    return this.failed;
  }
}

export class DefaultVmManager implements VmManager {
  private readonly vms = new Set<Vm>();
  private readonly queue: Vm[] = [];
  private pressure: MemoryPressureLevel = 'normal';
  private diskWatch: NodeJS.Timeout | null = null;
  private readonly freeBytes: (dir: string) => Promise<number>;
  private readonly allocatedBytes: (file: string) => Promise<number>;

  constructor(private readonly opts: VmManagerOptions) {
    this.freeBytes = opts.freeBytes ?? defaultFreeBytes;
    this.allocatedBytes = opts.allocatedBytes ?? defaultAllocatedBytes;
  }

  // ---------------------------------------------------------------------------
  // Admission
  // ---------------------------------------------------------------------------

  start(req: VmRequest): VmHandle {
    if (req.mode === 'job' && (req.sandboxId === undefined || req.shareNonce === undefined || req.proxyPort === undefined)) {
      throw new Error('a job VM needs its sandbox, its share nonce and its proxy port');
    }
    // At most one spare (the design's "Pre-warmed spare lifecycle"): each
    // holds a slot and its memory for a job that may not come for hours.
    if (req.spare === true && [...this.vms].some((vm) => vm.spare)) {
      throw new Error('there is already a spare Docker VM');
    }
    const vm = new Vm(req, this.opts.dataDir, (target, reason) => this.stopVm(target, reason));
    this.vms.add(vm);
    this.queue.push(vm);
    this.opts.log('debug', `Docker VM ${vm.vmId} queued for ${req.repository}${vm.spare ? ' (spare)' : ''}`);
    void this.lifecycle(vm);
    this.pump();
    return vm;
  }

  claimSpare(vmId: string): boolean {
    for (const vm of this.vms) {
      if (vm.vmId === vmId && vm.spare && ['queued', 'booting', 'ready'].includes(vm.status)) {
        vm.spare = false;
        this.pump();
        return true;
      }
    }
    return false;
  }

  /**
   * VMs holding memory: every one admitted and not yet gone. A VM leaves
   * this.vms only once its helper has exited, so one that failed still
   * counts while its helper is on its way out.
   */
  private holding(): number {
    let n = 0;
    for (const vm of this.vms) if (vm.status !== 'queued') n++;
    return n;
  }

  /**
   * Admit what the gate allows: jobs first, in the order they came; then the
   * spare, then refreshes, and those two only while memory pressure is
   * normal. At critical pressure nothing new boots.
   */
  private pump(): void {
    const { maxRunning } = this.opts.config();
    const rank = (vm: Vm) => (vm.request.mode === 'refresh' ? 2 : vm.spare ? 1 : 0);
    while (this.queue.length > 0 && this.pressure !== 'critical' && this.holding() < maxRunning) {
      const candidates = this.queue.filter((vm) => rank(vm) === 0 || this.pressure === 'normal');
      if (candidates.length === 0) return;
      const next = candidates.reduce((best, vm) => (rank(vm) < rank(best) ? vm : best));
      this.queue.splice(this.queue.indexOf(next), 1);
      next.status = 'booting';
      next.admit();
    }
    // A job that finds the gate full takes the spare's slot: the spare waits
    // for a job that may never come, this one has come. Its stop pumps again.
    if (this.pressure !== 'critical' && this.holding() >= maxRunning && this.queue.some((vm) => rank(vm) === 0)) {
      for (const vm of this.vms) {
        if (vm.spare && (vm.status === 'booting' || vm.status === 'ready')) void vm.stop('a job needs its slot');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // A VM's life
  // ---------------------------------------------------------------------------

  /** Race a stage against the VM being stopped. */
  private until<T>(vm: Vm, work: Promise<T>, inflight = true): Promise<T> {
    if (inflight) vm.inflight = work.catch(() => undefined);
    if (vm.abort.signal.aborted) return Promise.reject(new Cancelled());
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Cancelled());
      vm.abort.signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value) => {
          vm.abort.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err) => {
          vm.abort.signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
    });
  }

  private async lifecycle(vm: Vm): Promise<void> {
    const began = Date.now();
    let exit: HelperExit | undefined;
    try {
      await this.until(vm, vm.admitted, false);
      let ready: VmReady;
      try {
        ready = await this.boot(vm, began);
      } catch (err) {
        if (!(err instanceof CorruptClone)) throw err;
        this.opts.log('warn', `Docker VM ${vm.vmId}: ${err.message}; it boots again on a blank disk`);
        await this.until(vm, this.resetForBlankDisk(vm));
        try {
          ready = await this.boot(vm, began);
        } catch (again) {
          // Once only: a second corrupt disk is a failure like any other.
          if (again instanceof CorruptClone) throw vmError('configure', 'E_DISK', again.message);
          throw again;
        }
      }
      vm.status = 'ready';
      vm.resolveReady(ready);
      this.startDiskWatch();
      this.opts.log(
        'info',
        `Docker VM ${vm.vmId} ready in ${ready.bootMs} ms for ${vm.request.repository} ` +
          `(dockerd ${ready.docker.version}, API ${ready.docker.apiVersion}, Rosetta ${ready.rosetta})`
      );
      vm.stage = 'running';
      exit = await vm.helper!.exited();
      if (vm.status === 'ready' && vm.request.mode === 'refresh' && exit.code === 0 && exit.stopped?.reason === 'guest' && exit.stopped.synced === true) {
        // A refresh ends this way: CacheDisks sends the agent shutdown, the
        // guest powers off, and the helper has synced the disk it wrote.
        vm.status = 'stopped';
        this.opts.log('info', `Docker VM ${vm.vmId} powered off after its cache refresh for ${vm.request.repository}`);
      } else if (vm.status === 'ready') {
        this.fail(vm, vmError('running', exit.errorCode ?? 'E_VM_STOPPED', "the job's Docker VM stopped unexpectedly"));
      }
    } catch (err) {
      if (err instanceof Cancelled) {
        vm.rejectReady(vmError(vm.stage, 'E_CANCELLED', `Docker VM ${vm.vmId} was stopped before it was ready`));
      } else {
        const failure = isVmError(err) ? err : vmError(vm.stage, 'E_VM', (err as Error).message);
        this.fail(vm, failure);
        vm.rejectReady(failure);
      }
    } finally {
      await vm.inflight;
      const index = this.queue.indexOf(vm);
      if (index !== -1) this.queue.splice(index, 1);
      if (vm.helper && !vm.helper.hasExited()) {
        exit = await vm.helper.stop(0);
      } else if (vm.helper) {
        exit = await vm.helper.exited();
      }
      vm.agentClient?.close();
      await fs.promises.rm(vm.files.dir, { recursive: true, force: true }).catch((err: Error) =>
        this.opts.log('warn', `Could not remove Docker VM ${vm.vmId}'s directory; the next startup will: ${err.message}`)
      );
      if (vm.status !== 'failed') vm.status = 'stopped';
      this.vms.delete(vm);
      vm.resolveEnded({ reason: exit?.stopped?.reason ?? 'killed', synced: exit?.stopped?.synced === true });
      this.opts.log('debug', `Docker VM ${vm.vmId} gone`);
      this.pump();
      if (![...this.vms].some((v) => v.status === 'ready')) this.stopDiskWatch();
    }
  }

  private fail(vm: Vm, failure: VmError): void {
    if (vm.failed) return;
    vm.failed = failure;
    vm.status = 'failed';
    const level = failure.stage === 'nonce' ? 'error' : 'warn';
    this.opts.log(level, `Docker VM ${vm.vmId} failed at ${failure.stage} (${failure.code}): ${failure.message}`);
  }

  private async boot(vm: Vm, began: number): Promise<VmReady> {
    const req = vm.request;
    const config = this.opts.config();

    // The disk.
    vm.stage = 'disk';
    await this.until(vm, this.makeVmDir(vm));
    if (req.mode === 'job') {
      const sizeGiB = await this.until(vm, this.dataDiskGiB(vm, config));
      vm.apparentBytes = sizeGiB * GiB;
      try {
        vm.diskKind = await this.until(vm, this.opts.cacheDisks.prepareJobDisk(req.repoKey, vm.files.dataDisk, sizeGiB));
      } catch (err) {
        if (err instanceof Cancelled) throw err;
        throw vmError('disk', 'E_DISK', `could not prepare the VM's data disk: ${(err as Error).message}`);
      }
    }

    // The checks Electron makes before the helper makes them again (§2.1),
    // the profile, and the spawn.
    vm.stage = 'helper';
    try {
      await this.until(vm, this.opts.guest.verify());
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      throw vmError('helper', 'E_GUEST_IMAGE', (err as Error).message);
    }
    if (req.mode === 'job') this.checkShare(req);
    const helperPath = this.opts.helperPath();
    fs.writeFileSync(
      vm.files.profile,
      buildHelperProfile({
        mode: req.mode,
        helper: helperPath,
        resources: this.opts.resources,
        dataDir: this.opts.dataDir,
        vmId: vm.vmId,
        ...(req.mode === 'job' ? { sandboxId: req.sandboxId, proxyPort: req.proxyPort } : { repoKey: req.repoKey }),
      }),
      { flag: 'wx', mode: 0o600 }
    );
    const spawnHelper = this.opts.spawnHelper ?? sandboxedHelperSpawn;
    const helper = new HelperClient({
      helper: helperPath,
      args: {
        vmId: vm.vmId,
        mode: req.mode,
        dataDir: this.opts.dataDir,
        resources: this.opts.resources,
        ...(req.mode === 'job' ? { sandboxId: req.sandboxId, proxyPort: req.proxyPort } : { repoKey: req.repoKey }),
        cpus: config.cpus,
        memoryMiB: config.memoryMiB,
        rosetta: req.mode === 'job' ? 'auto' : 'off',
      },
      spawn: spawnHelper(vm.files.profile, vm.files.dir),
      env: { PATH: '/usr/bin:/bin', TMPDIR: vm.files.dir },
      expectSockets: { dockerSocket: vm.files.dockerSocket, agentSocket: vm.files.agentSocket },
      log: (level, message) => this.opts.log(level === 'error' ? 'warn' : level, `[vm ${vm.vmId}] ${message}`),
      ...(this.opts.killAfterMs !== undefined ? { killAfterMs: this.opts.killAfterMs } : {}),
    });
    vm.helper = helper;
    helper.start();
    const pid = helper.pid();
    if (pid !== undefined) fs.writeFileSync(vm.files.pidFile, `${pid}\n`, { mode: 0o600 });

    const started = await this.until(
      vm,
      new Promise<StartedEvent>((resolve, reject) => {
        helper.once('started', resolve);
        helper.exited().then((exit) =>
          reject(vmError('helper', exit.errorCode ?? 'E_HELPER_EXIT', `the VM helper exited before the VM started (${exit.errorCode ?? `code ${exit.code}`})`))
        );
      })
    );
    vm.started = started;

    // The agent, once it answers, then configure.
    vm.stage = 'agent';
    const agent = await this.until(vm, this.connectAgent(vm));
    vm.agentClient = agent;
    vm.stage = 'configure';
    let result;
    try {
      result = await this.until(
        vm,
        agent.configure({
          vmId: vm.vmId,
          mode: req.mode,
          timeUnixMs: Date.now(),
          ...(req.mode === 'job'
            ? {
                share: { tag: 'work' as const, mountPath: req.shareRealPath!, nonceFile: '.localmost-share' as const },
                relay: { address: '198.18.0.1' as const, port: 3128 as const, vsockPort: 3128 as const },
              }
            : {}),
          rosetta: started.rosetta === 'installed',
        })
      );
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      const code = err instanceof AgentClientError ? err.code : 'E_CONFIGURE';
      if (code === 'E_DISK' && req.mode === 'job' && vm.diskKind === 'clone') {
        // The disk was a clone of the repository's golden disk, which the
        // guest found corrupt: the cache goes, and this VM, once, and every
        // later job until the next refresh, starts blank.
        await this.opts.cacheDisks.discard(req.repoKey, 'corrupt').catch(() => {});
        throw new CorruptClone("the repository's cache disk was corrupt and has been discarded");
      }
      throw vmError('configure', code, (err as Error).message);
    }
    // A refresh VM has no relay and no share, so its self-test checks the
    // firewall rules alone and reports the rest false, as not run (§3.4).
    const checked = req.mode === 'job' ? Object.entries(result.selftest) : [['rules', result.selftest.rules] as const];
    const failedSelfTests = checked.filter(([, passed]) => !passed).map(([name]) => name);
    if (failedSelfTests.length > 0) {
      throw vmError('configure', 'E_SELFTEST', `the guest's firewall self-test failed: ${failedSelfTests.join(', ')}`);
    }

    // The share's tripwire: what the guest read through the share must be
    // what the app wrote. Otherwise VZ shared something else, and both layers
    // that should have stopped that failed.
    if (req.mode === 'job') {
      vm.stage = 'nonce';
      const expected = Buffer.from(req.shareNonce!);
      const got = Buffer.from(result.nonce ?? '');
      if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
        throw vmError('nonce', 'E_NONCE', "the guest did not read the share's nonce back: the VM was not given the job's own work folder");
      }
    }
    return {
      docker: { version: result.docker.version, apiVersion: result.docker.apiVersion },
      rosetta: result.rosetta,
      bootMs: Date.now() - began,
    };
  }

  /** Stop the helper that found the clone corrupt, and empty the VM's directory for a second boot. */
  private async resetForBlankDisk(vm: Vm): Promise<void> {
    vm.agentClient?.close();
    vm.agentClient = null;
    if (vm.helper && !vm.helper.hasExited()) await vm.helper.stop(0);
    vm.helper = null;
    vm.started = undefined;
    vm.apparentBytes = 0;
    await fs.promises.rm(vm.files.dir, { recursive: true, force: true });
  }

  /** Hello, again and again, until the agent answers or has been silent too long. */
  private async connectAgent(vm: Vm): Promise<UnixAgentClient> {
    const deadline = Date.now() + (this.opts.agentSilentMs ?? AGENT_SILENT_MS);
    for (;;) {
      if (vm.helper?.hasExited()) {
        const exit = await vm.helper.exited();
        throw vmError('helper', exit.errorCode ?? 'E_HELPER_EXIT', 'the VM helper exited before the guest agent answered');
      }
      const agent = new UnixAgentClient({
        socketPath: vm.files.agentSocket,
        log: (level, message) => this.opts.log(level, `[vm ${vm.vmId}] ${message}`),
      });
      try {
        await agent.hello();
        return agent;
      } catch (err) {
        agent.close();
        const code = err instanceof AgentClientError ? err.code : 'E_AGENT';
        if (code !== 'E_AGENT_CLOSED' && code !== 'E_AGENT_TIMEOUT') throw vmError('agent', code, (err as Error).message);
        if (Date.now() >= deadline || vm.abort.signal.aborted) {
          throw vmError('agent', 'E_AGENT_SILENT', 'the guest agent did not answer within 30 s');
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.opts.agentRetryMs ?? AGENT_RETRY_MS));
    }
  }

  private async makeVmDir(vm: Vm): Promise<void> {
    const root = vmDir(this.opts.dataDir);
    let madeRoot = false;
    try {
      await fs.promises.mkdir(root, { mode: 0o700 });
      madeRoot = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw vmError('disk', 'E_VM_DIR', (err as Error).message);
    }
    if (madeRoot) {
      await (this.opts.excludeFromBackup ?? defaultExcludeFromBackup)(root).catch((err: Error) =>
        this.opts.log('debug', `Could not exclude ${root} from Time Machine: ${err.message}`)
      );
    }
    await fs.promises.mkdir(path.dirname(vm.files.dir), { recursive: true, mode: 0o700 });
    try {
      // Not recursive: a VM id is never reused, so a directory already there
      // is not this VM's.
      await fs.promises.mkdir(vm.files.dir, { mode: 0o700 });
    } catch (err) {
      throw vmError('disk', 'E_VM_DIR', `cannot make the VM's directory: ${(err as Error).message}`);
    }
  }

  /**
   * The data disk's apparent size: dockerVm.dataDiskGiB, or less when free
   * space is short - never into the floor, nor into what running VMs' disks
   * were promised and have not yet used (§5.6).
   */
  private async dataDiskGiB(vm: Vm, config: DockerVmConfig): Promise<number> {
    const free = await this.freeBytes(this.opts.dataDir);
    let promised = 0;
    for (const other of this.vms) {
      if (other === vm || other.apparentBytes === 0) continue;
      promised += Math.max(0, other.apparentBytes - (await this.allocatedBytes(other.files.dataDisk)));
    }
    const available = free - config.minFreeGiB * GiB - promised;
    const size = Math.min(config.dataDiskGiB * GiB, available);
    if (size < MIN_DATA_DISK_BYTES) throw vmError('disk', 'E_NO_DISK', 'not enough free disk for a Docker VM');
    return Math.floor(size / GiB);
  }

  /**
   * The share checks the helper makes again right before VZ starts (§2.1):
   * `_work` a real directory, not a link, at its own real path, under
   * runner/sandbox, on the sandbox's device, and the sandbox on
   * runner/sandbox's - so nothing is mounted over the share or its sandbox.
   */
  private checkShare(req: VmRequest): void {
    const dataDir = this.opts.dataDir;
    const deviceOf = this.opts.deviceOf ?? ((p: string) => fs.statSync(p).dev);
    try {
      const base = fs.realpathSync(path.join(dataDir, 'runner', 'sandbox'));
      const sandbox = fs.realpathSync(sandboxDirOf(dataDir, req.sandboxId!));
      const share = `${sandbox}/_work`;
      const stat = fs.lstatSync(share);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('it is not a directory');
      if (fs.realpathSync(share) !== share) throw new Error('it is not at its real path');
      if (!share.startsWith(`${base}/`)) throw new Error('it is not under runner/sandbox');
      if (deviceOf(share) !== deviceOf(sandbox)) throw new Error('something is mounted over it');
      // A mount over the sandbox puts the share on the mounted device too,
      // which the check above cannot see, nor the helper's mount-point check.
      if (deviceOf(sandbox) !== deviceOf(base)) throw new Error('something is mounted over its sandbox');
      // <data> is real, and so is every directory the app made below it: the
      // share's path as built from the ids is its real path, or something on
      // the way was replaced.
      if (share !== sandboxFiles(dataDir, req.sandboxId!).share) throw new Error('its path runs through a link');
      if (req.shareRealPath !== undefined && req.shareRealPath !== share) throw new Error('it is not the share the VM was asked for');
    } catch (err) {
      throw vmError('helper', 'E_SHARE', `the job's work folder cannot be shared with its VM: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Stopping
  // ---------------------------------------------------------------------------

  private async stopVm(vm: Vm, reason: string): Promise<void> {
    if (vm.status === 'queued') {
      this.opts.log('debug', `Docker VM ${vm.vmId} leaves the queue: ${reason}`);
    } else if (vm.status === 'booting' || vm.status === 'ready') {
      vm.status = 'stopping';
      this.opts.log('info', `Docker VM ${vm.vmId} stopping: ${sanitizeGuestText(reason, 200)}`);
    }
    vm.abort.abort();
    if (vm.helper && !vm.helper.hasExited()) void vm.helper.stop(0);
    await vm.ended;
  }

  /** Stop a VM because of the host, not its job: its handle reports why. */
  private stopFailing(vm: Vm, failure: VmError): Promise<void> {
    this.fail(vm, failure);
    vm.abort.abort();
    if (vm.helper && !vm.helper.hasExited()) void vm.helper.stop(0);
    return vm.ended.then(() => undefined);
  }

  async shutdownAll(): Promise<void> {
    this.stopDiskWatch();
    const all = [...this.vms].map((vm) => vm.stop('localmost is quitting'));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(all),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, this.opts.shutdownAllMs ?? SHUTDOWN_ALL_MS))),
    ]);
    if (timer) clearTimeout(timer);
    for (const vm of this.vms) vm.helper?.kill();
  }

  // ---------------------------------------------------------------------------
  // The host: wake, memory pressure, free space
  // ---------------------------------------------------------------------------

  onResume(): void {
    for (const vm of [...this.vms]) {
      if (vm.spare) {
        void vm.stop('the Mac woke from sleep');
        continue;
      }
      // VZ has no Linux time sync, and the guest clock stopped while the Mac slept.
      if (vm.status === 'ready' && vm.agentClient) {
        vm.agentClient.setTime(Date.now()).catch((err: Error) =>
          this.opts.log('warn', `Could not set Docker VM ${vm.vmId}'s clock after sleep: ${sanitizeGuestText(err.message, 200)}`)
        );
      }
    }
  }

  onMemoryPressure(level: MemoryPressureLevel): void {
    if (level === this.pressure) return;
    this.opts.log('info', `Memory pressure is ${level}${level === 'normal' ? '' : '; no spare Docker VM or cache refresh starts'}${level === 'critical' ? ', and new Docker VMs wait' : ''}`);
    this.pressure = level;
    if (level !== 'normal') {
      for (const vm of [...this.vms]) if (vm.spare) void vm.stop(`memory pressure is ${level}`);
    }
    this.pump();
  }

  private startDiskWatch(): void {
    if (this.diskWatch) return;
    this.diskWatch = setInterval(() => void this.checkFreeSpace(), this.opts.diskWatchMs ?? DISK_WATCH_MS);
    this.diskWatch.unref?.();
  }

  private stopDiskWatch(): void {
    if (this.diskWatch) clearInterval(this.diskWatch);
    this.diskWatch = null;
  }

  /** Under half the floor, stop the job VM whose disk grew most (§5.6). */
  async checkFreeSpace(): Promise<void> {
    const config = this.opts.config();
    let free: number;
    try {
      free = await this.freeBytes(this.opts.dataDir);
    } catch {
      return;
    }
    if (free >= (config.minFreeGiB * GiB) / 2) return;
    let largest: { vm: Vm; bytes: number } | null = null;
    for (const vm of this.vms) {
      if (vm.request.mode !== 'job' || (vm.status !== 'ready' && vm.status !== 'booting')) continue;
      const bytes = await this.allocatedBytes(vm.files.dataDisk);
      if (!largest || bytes > largest.bytes) largest = { vm, bytes };
    }
    if (largest) await this.stopFailing(largest.vm, vmError('running', 'E_DISK_FULL', 'host disk nearly full'));
  }

  // ---------------------------------------------------------------------------
  // The startup sweep
  // ---------------------------------------------------------------------------

  /**
   * Before the pool starts: kill any helper a previous run left - only a live
   * process whose executable is this app's helper, since its pid may have
   * been reused since - and remove every VM directory and unfinished refresh
   * disk. Names that are not a VM id or a repository key are left alone.
   */
  async sweep(): Promise<void> {
    const jobs = path.join(vmDir(this.opts.dataDir), 'jobs');
    const helper = this.opts.helperPath();
    const processExecutable = this.opts.processExecutable ?? processExecutableOf;
    const kill = this.opts.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
    let swept = 0;
    for (const name of await fs.promises.readdir(jobs).catch(() => [] as string[])) {
      if (!VM_ID_RE.test(name)) {
        this.opts.log('warn', `Leaving ${path.join(jobs, name)}, which is not a Docker VM's directory`);
        continue;
      }
      const files = vmJobFiles(this.opts.dataDir, name);
      const recorded = await fs.promises.readFile(files.pidFile, 'utf-8').catch(() => '');
      const pid = Number(recorded.split('\n')[0]);
      if (Number.isInteger(pid) && pid > 1 && (await processExecutable(pid)) === helper) {
        try {
          kill(pid, 'SIGKILL');
          this.opts.log('info', `Killed the helper of Docker VM ${name}, left by an earlier run (pid ${pid})`);
        } catch {
          // Gone in the meantime.
        }
      }
      await fs.promises.rm(files.dir, { recursive: true, force: true });
      swept++;
    }
    const cache = path.join(vmDir(this.opts.dataDir), 'cache');
    for (const repoKey of await fs.promises.readdir(cache).catch(() => [] as string[])) {
      if (!REPO_KEY_RE.test(repoKey)) continue;
      const { refresh } = cacheFiles(this.opts.dataDir, repoKey);
      if (fs.existsSync(refresh)) {
        await fs.promises.rm(refresh, { force: true });
        swept++;
      }
    }
    this.opts.log('info', `Docker VM sweep: removed ${swept} left over from an earlier run`);
  }
}
