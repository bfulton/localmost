/**
 * One localmost-vm helper process: its spawn, its stdio protocol and its exit
 * (contract §2.1, §2.4).
 *
 * The helper runs one VM. Electron spawns it through sandbox-exec under the
 * VM's own profile, with an environment of PATH and TMPDIR alone, and talks to
 * it over stdio: events arrive on stdout, commands go to stdin, and stderr
 * carries log lines. Everything it says is hostile input - it runs VZ, whose
 * guest is the job's - so each event is schema-checked and bounded, a line
 * that is not a valid event kills it, and its log lines are stripped of
 * control characters before they reach a log.
 *
 * The spawn is injected. The real one wraps the helper in sandbox-exec; the
 * unit tests run the fake helper (test/fakes/fake-localmost-vm.mjs) directly,
 * since seatbelt refuses a nested profile inside a job and does not exist off
 * macOS. helper-client.sandbox.test.ts covers the real wrapping.
 */

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import type { HelperErrorCode } from './types';
import { frame, lineSplitter, parseFrame, sanitizeGuestText } from './ndjson';

/** The §2.1 flags, less the paths the helper derives itself. */
export interface HelperRunArgs {
  vmId: string;
  mode: 'job' | 'refresh';
  dataDir: string;
  resources: string;
  sandboxId?: string;
  repoKey?: string;
  proxyPort?: number;
  cpus: number;
  memoryMiB: number;
  rosetta: 'auto' | 'off';
}

/** Starts the helper: the real one wraps it in sandbox-exec, tests run the fake directly. */
export type HelperSpawn = (helper: string, args: string[], env: Record<string, string>) => ChildProcess;

/**
 * The real spawn: `sandbox-exec -f <helper.sb> <helper> ...`, with only the
 * environment given, in the VM's own directory (the one its profile grants).
 */
export const sandboxedHelperSpawn =
  (profilePath: string, vmDir: string): HelperSpawn =>
  (helper, args, env) =>
    spawn('/usr/bin/sandbox-exec', ['-f', profilePath, helper, ...args], {
      cwd: vmDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

/** The §2.1 argument line for `localmost-vm run`. */
export function helperArgs(a: HelperRunArgs): string[] {
  const args = ['run', '--vm-id', a.vmId, '--mode', a.mode, '--data-dir', a.dataDir, '--resources', a.resources];
  if (a.mode === 'job') {
    args.push('--sandbox-id', String(a.sandboxId), '--proxy-port', String(a.proxyPort));
  } else {
    args.push('--repo-key', String(a.repoKey));
  }
  args.push('--cpus', String(a.cpus), '--memory-mib', String(a.memoryMiB), '--rosetta', a.rosetta);
  return args;
}

/** Exit codes the helper uses, by the §2.4 table. */
const EXIT_CODES: Record<number, HelperErrorCode> = {
  64: 'E_ARGS',
  65: 'E_SHARE',
  66: 'E_GUEST_IMAGE',
  67: 'E_DISK',
  68: 'E_VZ_CONFIG',
  69: 'E_VZ_START',
  70: 'E_SOCKET',
  71: 'E_GUEST_ERROR',
  72: 'E_SYNC',
};

/**
 * The error code a helper's exit means, or undefined for a clean one. An
 * exit code outside the table, a signal, or a protocol violation get codes
 * of the client's own.
 */
export function exitErrorCode(code: number | null, signal: NodeJS.Signals | null): string | undefined {
  if (code === 0) return undefined;
  if (code !== null) return EXIT_CODES[code] ?? 'E_HELPER_EXIT';
  return signal ? 'E_HELPER_KILLED' : 'E_HELPER_EXIT';
}

export type RosettaAvailability = 'installed' | 'notInstalled' | 'notSupported' | 'off';

export interface ListeningEvent {
  dockerSocket: string;
  agentSocket: string;
}
export interface StartedEvent {
  pid: number;
  rosetta: RosettaAvailability;
  startMs: number;
}
export interface StoppedEvent {
  reason: 'guest' | 'requested' | 'error';
  code?: string;
  message?: string;
  synced: boolean;
}
export interface HelperExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Why it failed, when it did: a §2.4 code, or E_HELPER_PROTOCOL / E_HELPER_EXIT / E_HELPER_KILLED. */
  errorCode?: string;
  /** Its `stopped` event, if it sent one. */
  stopped?: StoppedEvent;
}

export interface HelperClientOptions {
  helper: string;
  args: HelperRunArgs;
  spawn: HelperSpawn;
  /** The whole environment it runs with: PATH and TMPDIR (§2.1). */
  env: Record<string, string>;
  /** The sockets it must report in `listening`, which Electron already knows. */
  expectSockets: ListeningEvent;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** How long after SIGTERM before SIGKILL. Default 5 s. */
  killAfterMs?: number;
}

const ROSETTA: readonly RosettaAvailability[] = ['installed', 'notInstalled', 'notSupported', 'off'];
const STOP_REASONS: readonly StoppedEvent['reason'][] = ['guest', 'requested', 'error'];
const PING_STATES = ['starting', 'running', 'stopping'] as const;
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/** Bounded like a code the helper could send: upper-case, digits, underscores. */
const CODE_RE = /^[A-Z][A-Z0-9_]{0,31}$/;

export class HelperClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (answer: Record<string, unknown>) => void; reject: (err: Error) => void }>();
  private protocolError: string | null = null;
  private stoppedEvent: StoppedEvent | undefined;
  private listeningEvent: ListeningEvent | undefined;
  private startedEvent: StartedEvent | undefined;
  private exit: HelperExit | undefined;
  private readonly exitPromise: Promise<HelperExit>;
  private resolveExit!: (exit: HelperExit) => void;
  private killTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: HelperClientOptions) {
    super();
    this.exitPromise = new Promise((resolve) => (this.resolveExit = resolve));
  }

  /** Spawn the helper. Its events follow as 'listening', 'started', 'stopped' and 'exit'. */
  start(): void {
    if (this.child) throw new Error('the helper was already started');
    const child = this.opts.spawn(this.opts.helper, helperArgs(this.opts.args), this.opts.env);
    this.child = child;
    child.stdout?.on('data', lineSplitter((line) => this.onEvent(line), () => this.violate('a line over 64 KiB')));
    child.stderr?.on('data', lineSplitter((line) => this.onLogLine(line), () => this.opts.log('warn', 'the helper wrote a log line over 64 KiB; the rest of its log is dropped')));
    // A stdin the helper has closed is no error of ours; its exit says what happened.
    child.stdin?.on('error', () => {});
    child.on('error', (err) => {
      this.opts.log('error', `the helper could not be started: ${err.message}`);
      this.finish(null, null, 'E_HELPER_EXIT');
    });
    child.on('exit', (code, signal) => this.finish(code, signal));
  }

  pid(): number | undefined {
    return this.child?.pid;
  }

  listening(): ListeningEvent | undefined {
    return this.listeningEvent;
  }

  started(): StartedEvent | undefined {
    return this.startedEvent;
  }

  /** Resolves once the helper has exited, with how. */
  exited(): Promise<HelperExit> {
    return this.exitPromise;
  }

  hasExited(): boolean {
    return this.exit !== undefined;
  }

  /** Answers the helper's state, or rejects if it is gone or answers otherwise. */
  async ping(): Promise<(typeof PING_STATES)[number]> {
    const answer = await this.command({ op: 'ping' });
    const state = answer.state;
    if (!PING_STATES.includes(state as (typeof PING_STATES)[number])) {
      this.violate('a ping answer with no state');
      throw new Error('the helper answered ping without a state');
    }
    return state as (typeof PING_STATES)[number];
  }

  /**
   * Stop the VM (the design's "Job cancelled mid-boot" and teardown): send
   * `stop` with this grace, then SIGTERM once the grace has passed, then
   * SIGKILL if it still has not exited 5 s later. Resolves on the exit.
   */
  stop(graceMs: number): Promise<HelperExit> {
    if (this.exit) return this.exitPromise;
    const grace = Math.max(0, Math.min(60_000, Math.floor(graceMs)));
    this.command({ op: 'stop', graceMs: grace }).catch(() => {});
    const term = setTimeout(() => this.signal('SIGTERM'), grace);
    this.exitPromise.finally(() => clearTimeout(term));
    this.killTimer ??= setTimeout(() => this.signal('SIGKILL'), grace + (this.opts.killAfterMs ?? 5000));
    return this.exitPromise;
  }

  /** Close its stdin, which the helper takes as its parent going away. */
  closeStdin(): void {
    this.child?.stdin?.end();
  }

  /** SIGKILL, at once. VZ stops the VM within about 2 s of its host going (R27). */
  kill(): void {
    this.signal('SIGKILL');
  }

  private signal(signal: NodeJS.Signals): void {
    if (this.exit || !this.child) return;
    try {
      this.child.kill(signal);
    } catch {
      // Already gone; its exit is on its way.
    }
  }

  private command(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const stdin = this.child?.stdin;
    if (this.exit || !stdin || stdin.destroyed || !stdin.writable) {
      return Promise.reject(new Error('the helper is not running'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      stdin.write(frame({ id, ...body }));
    });
  }

  private onLogLine(line: string): void {
    const space = line.indexOf(' ');
    const level = space === -1 ? '' : line.slice(0, space);
    if (LOG_LEVELS.has(level)) {
      this.opts.log(level as 'debug' | 'info' | 'warn' | 'error', sanitizeGuestText(line.slice(space + 1), 1024));
    } else {
      this.opts.log('info', sanitizeGuestText(line, 1024));
    }
  }

  /** A line on stdout that is not a valid event or answer: the helper is killed. */
  private violate(what: string): void {
    if (this.protocolError) return;
    this.protocolError = what;
    this.opts.log('error', `the helper broke its protocol (${sanitizeGuestText(what, 200)}); killing it`);
    this.kill();
  }

  private onEvent(line: string): void {
    if (this.protocolError) return;
    const message = parseFrame(line);
    if (!message) {
      this.violate('a line that is not a JSON object with "v":1');
      return;
    }
    if (message.event === undefined) {
      this.onAnswer(message);
      return;
    }
    switch (message.event) {
      case 'listening': {
        const { dockerSocket, agentSocket } = message;
        if (this.listeningEvent || this.startedEvent) return this.violate('listening out of order');
        if (dockerSocket !== this.opts.expectSockets.dockerSocket || agentSocket !== this.opts.expectSockets.agentSocket) {
          return this.violate('listening on sockets other than its own');
        }
        this.listeningEvent = { dockerSocket, agentSocket };
        this.emit('listening', this.listeningEvent);
        return;
      }
      case 'started': {
        const { pid, rosetta, startMs } = message;
        if (!this.listeningEvent || this.startedEvent) return this.violate('started out of order');
        if (!Number.isInteger(pid) || (pid as number) <= 0) return this.violate('started with no pid');
        if (!ROSETTA.includes(rosetta as RosettaAvailability)) return this.violate('started with an unknown rosetta');
        if (typeof startMs !== 'number' || !Number.isFinite(startMs) || startMs < 0) return this.violate('started with no startMs');
        this.startedEvent = { pid: pid as number, rosetta: rosetta as RosettaAvailability, startMs };
        this.emit('started', this.startedEvent);
        return;
      }
      case 'stopped': {
        const { reason, code, message: text, synced } = message;
        if (this.stoppedEvent) return this.violate('stopped twice');
        if (!STOP_REASONS.includes(reason as StoppedEvent['reason'])) return this.violate('stopped with an unknown reason');
        if (code !== undefined && (typeof code !== 'string' || !CODE_RE.test(code))) return this.violate('stopped with a malformed code');
        if (synced !== undefined && typeof synced !== 'boolean') return this.violate('stopped with a malformed synced');
        this.stoppedEvent = {
          reason: reason as StoppedEvent['reason'],
          ...(code !== undefined ? { code: code as string } : {}),
          ...(text !== undefined ? { message: sanitizeGuestText(text, 1024) } : {}),
          synced: synced === true,
        };
        this.emit('stopped', this.stoppedEvent);
        return;
      }
      default:
        this.violate('an unknown event');
    }
  }

  private onAnswer(answer: Record<string, unknown>): void {
    const id = answer.id;
    const waiting = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (!waiting || typeof answer.ok !== 'boolean') {
      this.violate('an answer to no command');
      return;
    }
    this.pending.delete(id as number);
    if (answer.ok) {
      waiting.resolve(answer);
    } else {
      const code = typeof answer.code === 'string' && CODE_RE.test(answer.code) ? answer.code : 'E_HELPER';
      waiting.reject(Object.assign(new Error(sanitizeGuestText(answer.message ?? code, 512)), { code }));
    }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null, override?: string): void {
    if (this.exit) return;
    if (this.killTimer) clearTimeout(this.killTimer);
    const errorCode = this.protocolError ? 'E_HELPER_PROTOCOL' : override ?? exitErrorCode(code, signal);
    this.exit = {
      code,
      signal,
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(this.stoppedEvent ? { stopped: this.stoppedEvent } : {}),
    };
    for (const { reject } of this.pending.values()) reject(new Error('the helper exited'));
    this.pending.clear();
    this.resolveExit(this.exit);
    this.emit('exit', this.exit);
  }
}
