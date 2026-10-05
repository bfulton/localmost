/**
 * The macOS VM isolation backend: one fresh macOS VM per job, cloned from
 * the golden image, its runner started by the guest agent as the guest's
 * non-admin job user, and the VM and its clone gone when the job ends.
 * See docs/roadmap/macos-vm-jobs.md ("A job").
 *
 *   prepare      a slot (waiting behind the two macOS VMs a Mac may run),
 *                the VM directory, the helper's `run` under its profile -
 *                which clones the slot's disk and restores its saved state -
 *                then the agent's hello and `prepare` (host time, entropy,
 *                the two loopback relays)
 *   spawnWorker  the runner uploaded if the guest lacks the host's version,
 *                then the job: the worker's three runner files and its
 *                environment, less any name a job may not set
 *                (jobEnvNameAllowed); its output and exit come back
 *   release      the helper stopped (VZ pulls the VM's plug), the VM
 *                directory removed, the slot freed
 *
 * A `localmost test` run takes a VM the same way (prepareTestRun), but has
 * no runner: the CLI connects to the VM's agent.sock itself and sends the
 * workspace and each step (src/cli/test-vm.ts).
 *
 * The guest has no network device. Its only ways out are the helper's two
 * vsock relays, to the job's proxy and to the broker on 127.0.0.1, so the
 * worker's HTTP_PROXY and broker URL work unchanged inside it, and anything
 * that ignores the proxy reaches nothing.
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { MacAgentClient, MacAgentError, JOB_FILE_NAMES, jobEnvNameAllowed, type JobFiles, type MacAgentHello } from './agent-client';
import type { LaunchHelper, ReadyImage } from './golden-image';
import type { MacVmHelper } from './helper-client';
import { JOB_VM_CPUS, JOB_VM_MEMORY_MIB, hostRefusal, type HostInfo } from './host';
import { assertRemovable, macVmLayout, newMacVmId, vmDir, MAC_VM_ID_RE } from './paths';
import type { MacVmSlots, SlotNumber } from './slots';
import type { IsolationAvailability, IsolationBackend, IsolationJob, JobSignal, VmLease, WorkerHandle } from './types';
import { sanitizeGuestText } from '../../vm/ndjson';

/** The most one runner file may be (MacVMAgentCore.maxJobFileBytes). */
const MAX_JOB_FILE_BYTES = 16 << 10;

/**
 * What stays free on the data volume while job VMs run. A job's disk is a
 * clone of the golden disk's 100 GiB sparse length, so a job that writes
 * without end would otherwise fill the operator's volume: below this a VM
 * does not start, and a running one is stopped.
 */
export const JOB_DISK_RESERVE_BYTES = 10 * 2 ** 30;
const DISK_CHECK_MS = 5000;

const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GiB`;

export interface MacVmBackendDeps {
  dataDir: string;
  images: { ready(): ReadyImage | null; status(): { state: string; reason?: string } };
  slots: MacVmSlots;
  host: () => HostInfo;
  helperExists: () => boolean;
  launch: LaunchHelper;
  /** The host's runner of `version`, packed for the guest. */
  runnerArchive: (version: string) => Promise<{ bytes: Buffer; sha256: string }>;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** For the sweep: a live process's executable, and the helper's path. */
  processExecutable: (pid: number) => Promise<string | null>;
  helperPath: () => string;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** The bytes free to this user on the volume holding `dir`. */
  freeBytes: (dir: string) => Promise<number>;
  diskCheckMs?: number;
  /** How long the agent may take to answer after the VM starts: a cold boot logs in first. */
  agentReadyMs?: number;
  agentRetryMs?: number;
}

interface Job {
  key: string;
  job: VmLease;
  imageId: string;
  slot: SlotNumber | null;
  vmId: string | null;
  helper: MacVmHelper | null;
  agent: MacAgentClient | null;
  hello: MacAgentHello | null;
  worker: Worker | null;
  released: Promise<void> | null;
  abort: AbortController;
  diskTimer: NodeJS.Timeout | null;
}

/**
 * A job's runner as the caller sees it. Its events wait until the turn after
 * it is made, as a child process's do, so that a caller who attaches its
 * listeners once spawnWorker resolves sees the first line too.
 */
class Worker extends EventEmitter implements WorkerHandle {
  private ended = false;
  private queued: Array<() => void> | null = [];
  constructor(readonly pid: number) {
    super();
    setImmediate(() => {
      const queued = this.queued ?? [];
      this.queued = null;
      for (const deliver of queued) deliver();
    });
  }
  private deliver(fn: () => void): void {
    if (this.queued) this.queued.push(fn);
    else fn();
  }
  output(stream: 'stdout' | 'stderr', line: string): void {
    this.deliver(() => this.emit(stream, line));
  }
  end(code: number | null, signal: string | null): void {
    if (this.ended) return;
    this.ended = true;
    this.deliver(() => this.emit('exit', code, signal));
  }
  get hasEnded(): boolean {
    return this.ended;
  }
}

const AGENT_SIGNALS: Record<JobSignal, 'TERM' | 'INT' | 'KILL'> = { SIGTERM: 'TERM', SIGINT: 'INT', SIGKILL: 'KILL' };

export class MacVmBackend implements IsolationBackend {
  readonly type = 'macos-vm' as const;
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly deps: MacVmBackendDeps) {}

  available(): IsolationAvailability {
    const refusal = hostRefusal(this.deps.host());
    if (refusal) return { ok: false, reason: refusal };
    if (!this.deps.helperExists()) return { ok: false, reason: 'this build of localmost has no macOS VM helper' };
    if (!this.deps.images.ready()) {
      const status = this.deps.images.status();
      const why =
        status.state === 'not-built' ? 'no golden macOS image has been built: build one in Settings'
          : status.state === 'building' || status.state === 'needs-guided-setup' ? 'the golden macOS image is still being built'
            : `the golden macOS image cannot be used${status.reason ? `: ${status.reason}` : ''}`;
      return { ok: false, reason: why };
    }
    return { ok: true };
  }

  /** Whether a job VM runs on `imageId`: the image is not removed under it. */
  imageInUse(imageId: string): boolean {
    return [...this.jobs.values()].some((j) => j.imageId === imageId);
  }

  jobsRunning(): boolean {
    return this.jobs.size > 0;
  }

  async prepare(job: VmLease, signal?: AbortSignal): Promise<void> {
    if (this.jobs.has(job.key)) throw new Error(`job ${job.key} already has a macOS VM`);
    const availability = this.available();
    if (!availability.ok) throw new Error(availability.reason);
    const image = this.deps.images.ready()!;
    const rec: Job = {
      key: job.key, job, imageId: image.imageId, slot: null, vmId: null, helper: null, agent: null, hello: null, worker: null,
      released: null, abort: new AbortController(), diskTimer: null,
    };
    this.jobs.set(job.key, rec);
    const onAbort = () => rec.abort.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      rec.slot = await this.deps.slots.acquire(`job ${job.key}`, image.slots, rec.abort.signal);
      const free = await this.freeBytes();
      if (free < JOB_DISK_RESERVE_BYTES) {
        throw new Error(`the Mac has ${gib(free)} free, and a macOS VM job needs at least ${gib(JOB_DISK_RESERVE_BYTES)} to start`);
      }
      rec.vmId = newMacVmId(rec.slot);
      const dir = vmDir(this.deps.dataDir, rec.vmId);
      fs.mkdirSync(dir, { mode: 0o700 });
      const agentSocket = path.join(dir, 'agent.sock');
      const helper = this.deps.launch(
        {
          command: 'run', dataDir: this.deps.dataDir, imageId: image.imageId, vmId: rec.vmId, proxyPort: job.proxyPort,
          brokerPort: job.brokerPort, cpus: JOB_VM_CPUS, memoryMiB: JOB_VM_MEMORY_MIB, boot: 'restore',
        },
        { expectAgentSocket: agentSocket }
      );
      rec.helper = helper;
      helper.on('exit', (exit) => {
        if (rec.worker && !rec.worker.hasEnded) {
          this.deps.log('warn', `macOS VM ${rec.vmId} stopped while job ${job.key} ran (${exit.end?.message ?? exit.errorCode ?? exit.end?.reason ?? 'no reason'})`);
          rec.worker.end(null, 'SIGKILL');
        }
      });
      helper.start();
      this.watchDisk(rec);
      const started = await this.raced(rec, new Promise<{ boot: string; restoreSkipped?: string }>((resolve) => helper.once('started', resolve)));
      this.deps.log('info', `macOS VM ${rec.vmId} for job ${job.key} started (${started.boot}${started.restoreSkipped ? `: ${started.restoreSkipped}` : ''})`);
      const { agent, hello } = await this.connectAgent(rec, agentSocket);
      if (!hello.ready) throw new Error('the guest agent says this VM is not fresh: its setup did not finish, or a job already reached it');
      await agent.prepare({ timeMs: Date.now(), entropy: crypto.randomBytes(64), proxyPort: job.proxyPort, brokerPort: job.brokerPort });
    } catch (err) {
      const cancelled = rec.abort.signal.aborted;
      await this.release(job);
      if (cancelled) throw new Error(`job ${job.key} was cancelled while its macOS VM started`);
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * A VM for a `localmost test` run: everything prepare does, and then the
   * path of its agent.sock, which the CLI dials for the run itself. The VM
   * is the run's until release.
   */
  async prepareTestRun(lease: VmLease, signal?: AbortSignal): Promise<string> {
    await this.prepare(lease, signal);
    const rec = this.jobs.get(lease.key);
    if (!rec?.vmId) throw new Error(`test run ${lease.key} has no macOS VM`);
    return path.join(vmDir(this.deps.dataDir, rec.vmId), 'agent.sock');
  }

  /** The data volume's free bytes; 0, so nothing starts, when they cannot be read. */
  private freeBytes(): Promise<number> {
    return this.deps.freeBytes(macVmLayout(this.deps.dataDir).root).catch(() => 0);
  }

  /**
   * Stops the job's VM once the volume's free space falls below the
   * reserve: the job ends with SIGKILL and its clone goes at release.
   */
  private watchDisk(rec: Job): void {
    let checking = false;
    rec.diskTimer = setInterval(() => {
      if (checking || rec.released) return;
      checking = true;
      void this.freeBytes().then((free) => {
        checking = false;
        if (free >= JOB_DISK_RESERVE_BYTES || rec.released || !rec.diskTimer) return;
        clearInterval(rec.diskTimer);
        rec.diskTimer = null;
        this.deps.log('warn', `macOS VM ${rec.vmId}: the Mac has ${gib(free)} free, under the ${gib(JOB_DISK_RESERVE_BYTES)} reserve; stopping its VM and ending job ${rec.key}`);
        rec.abort.abort();
        rec.worker?.end(null, 'SIGKILL');
        if (rec.helper && !rec.helper.hasExited()) void rec.helper.stop(0);
      });
    }, this.deps.diskCheckMs ?? DISK_CHECK_MS);
  }

  /** Waits for `p`, failing as soon as the job is aborted or the helper exits. */
  private raced<T>(rec: Job, p: Promise<T>): Promise<T> {
    const helper = rec.helper!;
    return Promise.race([
      p,
      helper.exited().then((exit) => {
        throw new Error(`the macOS VM did not start: ${exit.end?.message ?? exit.errorCode ?? exit.end?.reason}`);
      }),
      new Promise<never>((_resolve, reject) => {
        if (rec.abort.signal.aborted) reject(new Error('cancelled'));
        rec.abort.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }),
    ]);
  }

  /** The agent, once it answers: right away after a restore, after the login on a cold boot. */
  private async connectAgent(rec: Job, socketPath: string): Promise<{ agent: MacAgentClient; hello: MacAgentHello }> {
    const deadline = Date.now() + (this.deps.agentReadyMs ?? 10 * 60_000);
    for (;;) {
      const agent = new MacAgentClient({ socketPath, log: (level, message) => this.deps.log(level, `macOS VM ${rec.vmId} agent: ${message}`) });
      try {
        const hello = await this.raced(rec, agent.connect());
        rec.agent = agent;
        rec.hello = hello;
        return { agent, hello };
      } catch (err) {
        agent.close();
        const retry = err instanceof MacAgentError && (err.code === 'E_AGENT_CLOSED' || err.code === 'E_AGENT_TIMEOUT');
        if (!retry || Date.now() > deadline) throw err;
        await this.raced(rec, new Promise((resolve) => setTimeout(resolve, this.deps.agentRetryMs ?? 2000)));
      }
    }
  }

  async spawnWorker(job: IsolationJob, argv: string[], env: Record<string, string>): Promise<WorkerHandle> {
    const rec = this.jobs.get(job.key);
    if (!rec?.agent || !rec.hello) throw new Error(`job ${job.key} has no prepared macOS VM`);
    if (rec.worker) throw new Error(`job ${job.key} already started its runner: a VM runs one job`);
    if (argv.length !== 1 || argv[0] !== '--once') throw new Error(`a macOS VM job's runner takes --once and nothing else, not ${JSON.stringify(argv)}`);
    if (!rec.hello.runnerVersions.includes(job.runnerVersion)) {
      this.deps.log('info', `macOS VM ${rec.vmId}: the guest has no runner ${job.runnerVersion}; sending it`);
      const archive = await this.deps.runnerArchive(job.runnerVersion);
      await rec.agent.uploadRunner(job.runnerVersion, archive.bytes, archive.sha256);
    }
    const files = readJobFiles(job.sandboxDir);
    const dropped = Object.keys(env).filter((name) => !jobEnvNameAllowed(name));
    const kept = Object.fromEntries(Object.entries(env).filter(([name]) => jobEnvNameAllowed(name)));
    if (dropped.length > 0) this.deps.log('debug', `macOS VM ${rec.vmId}: the guest's runner does not get ${dropped.sort().join(', ')}`);
    const agent = rec.agent;
    // The job's output and even its exit can arrive in the read that brings
    // the job's answer, before the await below resumes: they are held from
    // the start and handed to the worker once it exists.
    let worker: Worker | null = null;
    const early: Array<(w: Worker) => void> = [];
    const toWorker = (fn: (w: Worker) => void) => (worker ? fn(worker) : early.push(fn));
    agent.on('output', (stream: 'stdout' | 'stderr', line: string) => toWorker((w) => w.output(stream, line)));
    agent.on('exit', (code: number | null, signal: string | null) => toWorker((w) => w.end(code, signal)));
    agent.on('closed', (err: MacAgentError) => toWorker((w) => {
      if (w.hasEnded) return;
      this.deps.log('warn', `macOS VM ${rec.vmId}: lost the guest agent while job ${job.key} ran: ${sanitizeGuestText(err.message, 300)}`);
      w.end(null, 'SIGKILL');
    }));
    const pid = await agent.job({ runnerVersion: job.runnerVersion, files, env: kept, args: ['--once'] });
    const started = new Worker(pid);
    worker = started;
    rec.worker = started;
    for (const fn of early.splice(0)) fn(started);
    return started;
  }

  async signal(job: IsolationJob, signal: JobSignal): Promise<void> {
    const rec = this.jobs.get(job.key);
    if (!rec?.agent || !rec.worker || rec.worker.hasEnded) return;
    await rec.agent.signal(AGENT_SIGNALS[signal]).catch((err) => {
      this.deps.log('warn', `macOS VM ${rec.vmId}: ${signal} could not be sent: ${(err as Error).message}`);
    });
  }

  release(job: VmLease): Promise<void> {
    const rec = this.jobs.get(job.key);
    if (!rec) return Promise.resolve();
    rec.released ??= (async () => {
      if (rec.diskTimer) clearInterval(rec.diskTimer);
      rec.diskTimer = null;
      rec.abort.abort();
      rec.agent?.close();
      // The slot is freed and the record dropped however the teardown goes:
      // a helper that would not stop or a directory that would not go must
      // not hold one of the Mac's two VMs until the app restarts. The error
      // still reaches the caller.
      try {
        if (rec.helper && !rec.helper.hasExited()) {
          // The guest is the job's and is thrown away: no grace.
          await rec.helper.stop(0);
        }
      } finally {
        rec.worker?.end(null, 'SIGKILL');
        try {
          if (rec.vmId) {
            const dir = vmDir(this.deps.dataDir, rec.vmId);
            assertRemovable(this.deps.dataDir, dir, 'vms', MAC_VM_ID_RE);
            await fs.promises.rm(dir, { recursive: true, force: true });
          }
        } finally {
          if (rec.slot) this.deps.slots.release(rec.slot);
          this.jobs.delete(job.key);
        }
      }
    })();
    return rec.released;
  }

  /**
   * Before any job: kills each helper a previous run left - only a live
   * process whose executable is this app's helper, since its pid may have
   * been reused - and removes every VM directory.
   */
  async sweep(): Promise<void> {
    const vms = macVmLayout(this.deps.dataDir).vmsDir;
    const helper = this.deps.helperPath();
    const kill = this.deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
    let swept = 0;
    for (const name of await fs.promises.readdir(vms).catch(() => [] as string[])) {
      if (!MAC_VM_ID_RE.test(name)) {
        this.deps.log('warn', `macOS VM sweep: leaving ${path.join(vms, name)}, which is not a VM's directory`);
        continue;
      }
      const dir = vmDir(this.deps.dataDir, name);
      const recorded = await fs.promises.readFile(path.join(dir, 'helper.pid'), 'utf8').catch(() => '');
      const pid = Number(recorded.split('\n')[0]);
      if (Number.isInteger(pid) && pid > 1 && (await this.deps.processExecutable(pid)) === helper) {
        try {
          kill(pid, 'SIGKILL');
          this.deps.log('info', `macOS VM sweep: killed the helper of VM ${name}, left by an earlier run (pid ${pid})`);
        } catch {
          // Gone in the meantime.
        }
      }
      assertRemovable(this.deps.dataDir, dir, 'vms', MAC_VM_ID_RE);
      await fs.promises.rm(dir, { recursive: true, force: true });
      swept++;
    }
    const profiles = path.join(macVmLayout(this.deps.dataDir).root, 'profiles');
    for (const name of await fs.promises.readdir(profiles).catch(() => [] as string[])) {
      if (/^[a-z-]+-[0-9a-f]{12}\.sb$/.test(name)) await fs.promises.rm(path.join(profiles, name), { force: true });
    }
    if (swept > 0) this.deps.log('info', `macOS VM sweep: removed ${swept} VM directories left by an earlier run`);
  }
}

/** The worker's three runner files, each a regular file (never through a link) of at most 16 KiB. */
export function readJobFiles(sandboxDir: string): JobFiles {
  const files = {} as JobFiles;
  for (const name of JOB_FILE_NAMES) {
    const file = path.join(sandboxDir, name);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > MAX_JOB_FILE_BYTES) throw new Error(`${file} is not a regular file of at most ${MAX_JOB_FILE_BYTES} bytes`);
      const text = fs.readFileSync(fd, 'utf8');
      if (text.includes('\u0000')) throw new Error(`${file} holds a NUL`);
      files[name] = text;
    } finally {
      fs.closeSync(fd);
    }
  }
  return files;
}
