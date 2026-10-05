/**
 * One localmost-macvm helper process: its argument line, its spawn under
 * the command's own seatbelt profile, its stdio protocol and its exit
 * (native/localmost-macvm, docs/roadmap/macos-vm-jobs.md "The helper").
 *
 * Every command is one short-lived process that ends with one `end` event.
 * The VM commands (provision, save-state, run) also take commands on stdin
 * (`ping`, `stop`, and provision's account) and emit events as the VM comes
 * up. Everything the helper says is hostile input - it runs VZ, and in a job
 * VM the guest is the job's - so each event is checked against the events
 * its command may send and their fields, a line that is not one kills it,
 * and log lines are stripped of control characters before they are logged.
 *
 * The spawn is injected: the real one wraps the helper in sandbox-exec, the
 * unit tests run test/fakes/fake-localmost-macvm.mjs directly.
 */

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { frame, lineSplitter, parseFrame, sanitizeGuestText } from '../../vm/ndjson';
import { IMAGE_ID_RE, MAC_VM_ID_RE } from './paths';

export type MacVmCommand = 'catalog' | 'inspect' | 'install' | 'provision' | 'save-state' | 'run' | 'check';

export interface InstallArgs {
  dataDir: string;
  imageId: string;
  ipsw: string;
  diskGiB: number;
  slot: 1 | 2;
}
export interface ProvisionArgs {
  dataDir: string;
  imageId: string;
  slot: 1 | 2;
  display: 'none' | 'window';
}
export interface SaveStateArgs {
  dataDir: string;
  imageId: string;
  slot: 1 | 2;
  cpus: number;
  memoryMiB: number;
}
export interface RunArgs {
  dataDir: string;
  imageId: string;
  vmId: string;
  proxyPort: number;
  brokerPort: number;
  cpus: number;
  memoryMiB: number;
  boot: 'restore' | 'cold';
}

export type HelperInvocation =
  | { command: 'catalog' }
  | { command: 'inspect'; ipsw: string }
  | ({ command: 'install' } & InstallArgs)
  | ({ command: 'provision' } & ProvisionArgs)
  | ({ command: 'save-state' } & SaveStateArgs)
  | ({ command: 'run' } & RunArgs)
  | { command: 'check'; dataDir: string; imageId: string };

const requireForm = (value: string, form: RegExp, what: string): string => {
  if (!form.test(value)) throw new Error(`not a ${what}: ${JSON.stringify(value)}`);
  return value;
};

const requireInt = (value: number, min: number, max: number, what: string): string => {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${what} must be an integer from ${min} to ${max}: ${value}`);
  return String(value);
};

/** The helper's argument line, by its parser's rules (MacVMCore/Args.swift). */
export function helperArgv(inv: HelperInvocation): string[] {
  switch (inv.command) {
    case 'catalog':
      return ['catalog'];
    case 'inspect':
      return ['inspect', '--ipsw', inv.ipsw];
    case 'install':
      return [
        'install', '--data-dir', inv.dataDir, '--image-id', requireForm(inv.imageId, IMAGE_ID_RE, 'image id'),
        '--ipsw', inv.ipsw, '--disk-gib', requireInt(inv.diskGiB, 40, 512, 'disk size'), '--slot', requireInt(inv.slot, 1, 2, 'slot'),
      ];
    case 'provision':
      return [
        'provision', '--data-dir', inv.dataDir, '--image-id', requireForm(inv.imageId, IMAGE_ID_RE, 'image id'),
        '--slot', requireInt(inv.slot, 1, 2, 'slot'), '--display', inv.display,
      ];
    case 'save-state':
      return [
        'save-state', '--data-dir', inv.dataDir, '--image-id', requireForm(inv.imageId, IMAGE_ID_RE, 'image id'),
        '--slot', requireInt(inv.slot, 1, 2, 'slot'), '--cpus', requireInt(inv.cpus, 2, 32, 'cpus'),
        '--memory-mib', requireInt(inv.memoryMiB, 4096, 65536, 'memory'),
      ];
    case 'run':
      if (inv.proxyPort === inv.brokerPort) throw new Error('the proxy and broker ports must differ');
      return [
        'run', '--data-dir', inv.dataDir, '--image-id', requireForm(inv.imageId, IMAGE_ID_RE, 'image id'),
        '--vm-id', requireForm(inv.vmId, MAC_VM_ID_RE, 'macOS VM id'),
        '--proxy-port', requireInt(inv.proxyPort, 1, 65535, 'proxy port'),
        '--broker-port', requireInt(inv.brokerPort, 1, 65535, 'broker port'),
        '--cpus', requireInt(inv.cpus, 2, 32, 'cpus'), '--memory-mib', requireInt(inv.memoryMiB, 4096, 65536, 'memory'),
        '--boot', inv.boot,
      ];
    case 'check':
      return ['check', '--data-dir', inv.dataDir, '--image-id', requireForm(inv.imageId, IMAGE_ID_RE, 'image id')];
  }
}

/** The helper's exit codes (MacVMCore/Errors.swift). */
export const MACVM_EXIT_CODES: Readonly<Record<number, string>> = Object.freeze({
  64: 'E_ARGS',
  65: 'E_IMAGE',
  66: 'E_IPSW',
  67: 'E_INSTALL',
  68: 'E_VZ_CONFIG',
  69: 'E_VZ_START',
  70: 'E_SOCKET',
  71: 'E_GUEST_ERROR',
  72: 'E_SLOT',
  73: 'E_CLONE',
  74: 'E_STATE',
  75: 'E_UNSUPPORTED',
  76: 'E_CATALOG',
});

export function exitErrorCode(code: number | null, signal: NodeJS.Signals | null): string | undefined {
  if (code === 0) return undefined;
  if (code !== null) return MACVM_EXIT_CODES[code] ?? 'E_HELPER_EXIT';
  return signal ? 'E_HELPER_KILLED' : 'E_HELPER_EXIT';
}

/** Starts the helper: the real one wraps it in sandbox-exec, tests run the fake directly. */
export type MacVmSpawn = (helper: string, args: string[], env: Record<string, string>) => ChildProcess;

/** `sandbox-exec -f <profile> <helper> ...`, with only the environment given, in `cwd`. */
export const sandboxedMacVmSpawn =
  (profilePath: string, cwd: string): MacVmSpawn =>
  (helper, args, env) =>
    spawn('/usr/bin/sandbox-exec', ['-f', profilePath, helper, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });

export interface EndEvent {
  ok: boolean;
  reason: 'done' | 'requested' | 'guest' | 'error';
  code?: string;
  message?: string;
  /** The command's own result fields, checked. */
  result: Record<string, unknown>;
}

export interface StartedEvent {
  pid: number;
  boot: 'cold' | 'restore';
  startMs: number;
  /** provision: the NAT interface's address, whose lease names the guest's IP. */
  mac?: string;
  /** run: why it booted cold although asked to restore. */
  restoreSkipped?: string;
}

export interface HelperExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Why it failed: the helper's code, or E_HELPER_PROTOCOL / E_HELPER_EXIT / E_HELPER_KILLED. */
  errorCode?: string;
  end?: EndEvent;
}

const CODE_RE = /^E_[A-Z_]{2,30}$/;
const BUILD_RE = /^[0-9A-Za-z]{3,16}$/;
const OS_RE = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/;
const HOST_BUILD_RE = /^[0-9A-Za-z]{3,16}$/;
const VERSION_RE = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;
const MAC_RE = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/** The one host a restore image is downloaded from (MacVMCore/Catalog.swift). */
export const RESTORE_IMAGE_HOST = 'updates.cdn-apple.com';

/** An https URL on the restore image host with a path ending .ipsw, and nothing else. */
export function isAllowedRestoreImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' && url.hostname === RESTORE_IMAGE_HOST && url.port === '' && url.username === '' &&
    url.password === '' && url.search === '' && url.hash === '' && url.pathname.endsWith('.ipsw') &&
    !value.includes('/../') && url.href === value
  );
}

const isCount = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isText = (v: unknown, form: RegExp): v is string => typeof v === 'string' && form.test(v);

/** Throws unless every key of `o` is allowed, and returns those that are present. */
function pick(o: Record<string, unknown>, allowed: readonly string[], what: string): Record<string, unknown> {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new Error(`${what} has fields it may not: ${extra.slice(0, 4).join(', ')}`);
  return o;
}

/** The result fields an ok `end` carries, by command; anything else is a violation. */
function checkResult(command: MacVmCommand, fields: Record<string, unknown>): Record<string, unknown> {
  const image = (f: Record<string, unknown>): void => {
    if (!isText(f.build, BUILD_RE) || !isText(f.os, OS_RE) || !isBool(f.supported) || !isCount(f.minCpus, 64) || !isCount(f.minMemoryBytes)) {
      throw new Error('a restore image without its build, version, support and minimums');
    }
  };
  switch (command) {
    case 'catalog':
      pick(fields, ['url', 'build', 'os', 'supported', 'minCpus', 'minMemoryBytes'], 'catalog');
      image(fields);
      if (!isAllowedRestoreImageUrl(fields.url)) throw new Error('a restore image URL off the allowlist');
      return fields;
    case 'inspect':
      pick(fields, ['build', 'os', 'supported', 'minCpus', 'minMemoryBytes'], 'inspect');
      image(fields);
      return fields;
    case 'install':
      pick(fields, ['build', 'os', 'diskBytes'], 'install');
      if (!isText(fields.build, BUILD_RE) || !isText(fields.os, OS_RE) || !isCount(fields.diskBytes)) throw new Error('an install without its build');
      return fields;
    case 'check': {
      pick(fields, ['build', 'os', 'supported', 'diskBytes', 'diskAllocatedBytes', 'states'], 'check');
      if (!isText(fields.build, BUILD_RE) || !isText(fields.os, OS_RE) || !isBool(fields.supported) || !isCount(fields.diskBytes) || !isCount(fields.diskAllocatedBytes)) {
        throw new Error('a check without its image');
      }
      const states = fields.states;
      if (typeof states !== 'object' || states === null || Array.isArray(states)) throw new Error('a check without its states');
      for (const [slot, s] of Object.entries(states as Record<string, unknown>)) {
        if (slot !== '1' && slot !== '2') throw new Error(`a state for slot ${sanitizeGuestText(slot, 8)}`);
        const st = s as Record<string, unknown>;
        if (typeof st !== 'object' || st === null) throw new Error('a state that is not an object');
        pick(st, ['hostBuild', 'cpus', 'memoryMiB', 'helperVersion', 'stateBytes'], 'a state');
        if (!isText(st.hostBuild, HOST_BUILD_RE) || !isCount(st.cpus, 64) || !isCount(st.memoryMiB, 1 << 20) || !isText(st.helperVersion, VERSION_RE) || !isCount(st.stateBytes)) {
          throw new Error('a state without its stamp');
        }
      }
      return fields;
    }
    default:
      pick(fields, [], command);
      return fields;
  }
}

/** The events each command may send before its `end`. */
const EVENTS: Readonly<Record<MacVmCommand, readonly string[]>> = Object.freeze({
  catalog: [],
  inspect: [],
  check: [],
  install: ['progress', 'image'],
  provision: ['ready', 'started'],
  'save-state': ['started', 'agentReady', 'saved'],
  run: ['listening', 'started', 'restore'],
});

export interface MacVmHelperOptions {
  helper: string;
  invocation: HelperInvocation;
  spawn: MacVmSpawn;
  /** The whole environment it runs with: PATH and TMPDIR. */
  env: Record<string, string>;
  /** run: the agent socket it must report in `listening`, which Electron already knows. */
  expectAgentSocket?: string;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** How long after SIGTERM before SIGKILL. Default 5 s. */
  killAfterMs?: number;
}

/**
 * One helper process. Events follow as `progress` ({phase, percent}),
 * `image`, `ready`, `listening`, `started`, `restore`, `agentReady`,
 * `saved`, each checked, then `exit` with the HelperExit.
 */
export class MacVmHelper extends EventEmitter {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (a: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private protocolError: string | null = null;
  private endEvent: EndEvent | undefined;
  private startedEvent: StartedEvent | undefined;
  private listened = false;
  private exit: HelperExit | undefined;
  private readonly exitPromise: Promise<HelperExit>;
  private resolveExit!: (exit: HelperExit) => void;
  private killTimer: NodeJS.Timeout | null = null;
  private lastPercent = -1;

  constructor(private readonly opts: MacVmHelperOptions) {
    super();
    this.exitPromise = new Promise((resolve) => (this.resolveExit = resolve));
  }

  get command(): MacVmCommand {
    return this.opts.invocation.command;
  }

  start(): void {
    if (this.child) throw new Error('the helper was already started');
    const child = this.opts.spawn(this.opts.helper, helperArgv(this.opts.invocation), this.opts.env);
    this.child = child;
    child.stdout?.on('data', lineSplitter((line) => this.onLine(line), () => this.violate('a line over 64 KiB')));
    child.stderr?.on(
      'data',
      lineSplitter((line) => this.onLogLine(line), () => this.opts.log('warn', 'the macOS VM helper wrote a log line over 64 KiB; the rest of its log is dropped'))
    );
    child.stdin?.on('error', () => {});
    child.on('error', (err) => {
      this.opts.log('error', `the macOS VM helper could not be started: ${err.message}`);
      this.finish(null, null, 'E_HELPER_EXIT');
    });
    child.on('close', (code, signal) => this.finish(code, signal));
  }

  pid(): number | undefined {
    return this.child?.pid;
  }

  started(): StartedEvent | undefined {
    return this.startedEvent;
  }

  exited(): Promise<HelperExit> {
    return this.exitPromise;
  }

  hasExited(): boolean {
    return this.exit !== undefined;
  }

  /** Runs the helper to its end: resolves with the ok end's result, or rejects with its code and message. */
  async result(): Promise<Record<string, unknown>> {
    if (!this.child) this.start();
    const exit = await this.exitPromise;
    if (exit.end?.ok && exit.errorCode === undefined) return exit.end.result;
    const code = exit.end?.code ?? exit.errorCode ?? 'E_HELPER_EXIT';
    const message = exit.end?.message ?? `the macOS VM helper's ${this.command} ended (${code})`;
    throw Object.assign(new Error(message), { code });
  }

  async ping(): Promise<string> {
    const answer = await this.request({ op: 'ping' });
    if (!['starting', 'running', 'saving', 'stopping'].includes(answer.state as string)) {
      this.violate('a ping answer with no state');
      throw new Error('the helper answered ping without a state');
    }
    return answer.state as string;
  }

  /** Sends a line that takes no answer: provision's account, the guided window's values. */
  send(body: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (this.exit || !stdin || stdin.destroyed || !stdin.writable) throw new Error('the helper is not running');
    stdin.write(frame(body));
  }

  /**
   * `stop` with this grace, then SIGTERM once it has passed, then SIGKILL if
   * it still has not exited. Resolves on the exit.
   */
  stop(graceMs = 0): Promise<HelperExit> {
    if (this.exit) return this.exitPromise;
    const grace = Math.max(0, Math.min(60_000, Math.floor(graceMs)));
    this.request({ op: 'stop', graceMs: grace }).catch(() => {});
    const term = setTimeout(() => this.signal('SIGTERM'), grace + 1000);
    void this.exitPromise.finally(() => clearTimeout(term));
    this.killTimer ??= setTimeout(() => this.signal('SIGKILL'), grace + 1000 + (this.opts.killAfterMs ?? 5000));
    return this.exitPromise;
  }

  kill(): void {
    this.signal('SIGKILL');
  }

  private signal(signal: NodeJS.Signals): void {
    if (this.exit || !this.child) return;
    try {
      this.child.kill(signal);
    } catch {
      // Gone already; its exit is on its way.
    }
  }

  private request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const stdin = this.child?.stdin;
    if (this.exit || !stdin || stdin.destroyed || !stdin.writable) return Promise.reject(new Error('the helper is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      stdin.write(frame({ id, ...body }));
    });
  }

  private onLogLine(line: string): void {
    const space = line.indexOf(' ');
    const level = space === -1 ? '' : line.slice(0, space);
    if (LOG_LEVELS.has(level)) this.opts.log(level as 'info', sanitizeGuestText(line.slice(space + 1), 1024));
    else this.opts.log('info', sanitizeGuestText(line, 1024));
  }

  private violate(what: string): void {
    if (this.protocolError) return;
    this.protocolError = what;
    this.opts.log('error', `the macOS VM helper broke its protocol (${sanitizeGuestText(what, 200)}); killing it`);
    this.kill();
  }

  private onLine(line: string): void {
    if (this.protocolError) return;
    const message = parseFrame(line);
    if (!message) return this.violate('a line that is not a JSON object with "v":1');
    if (this.endEvent) return this.violate('a line after its end');
    if (message.event === undefined) return this.onAnswer(message);
    const { event, ...rest } = message;
    const fields: Record<string, unknown> = { ...rest };
    delete fields.v;
    try {
      if (event === 'end') return this.onEnd(fields);
      if (typeof event !== 'string' || !EVENTS[this.command].includes(event)) throw new Error(`an event ${sanitizeGuestText(String(event), 32)} that ${this.command} does not send`);
      this.onEvent(event, fields);
    } catch (err) {
      this.violate((err as Error).message);
    }
  }

  private onEvent(event: string, f: Record<string, unknown>): void {
    switch (event) {
      case 'progress': {
        pick(f, ['phase', 'percent'], 'progress');
        if ((f.phase !== 'load' && f.phase !== 'install') || !isCount(f.percent, 100)) throw new Error('a progress without its phase and percent');
        if (f.phase === 'install') {
          if ((f.percent as number) < this.lastPercent) throw new Error('progress that went back');
          this.lastPercent = f.percent as number;
        }
        this.emit('progress', { phase: f.phase, percent: f.percent });
        return;
      }
      case 'image':
        pick(f, ['build', 'os', 'minCpus', 'minMemoryBytes'], 'image');
        if (!isText(f.build, BUILD_RE) || !isText(f.os, OS_RE) || !isCount(f.minCpus, 64) || !isCount(f.minMemoryBytes)) throw new Error('an image without its build');
        this.emit('image', { build: f.build, os: f.os, minCpus: f.minCpus, minMemoryBytes: f.minMemoryBytes });
        return;
      case 'ready':
      case 'agentReady':
      case 'saved':
        pick(f, [], event);
        this.emit(event);
        return;
      case 'listening': {
        pick(f, ['agentSocket'], 'listening');
        if (this.listened || this.startedEvent) throw new Error('listening out of order');
        if (f.agentSocket !== this.opts.expectAgentSocket) throw new Error('listening on a socket other than its own');
        this.listened = true;
        this.emit('listening', f.agentSocket);
        return;
      }
      case 'started': {
        pick(f, ['pid', 'boot', 'startMs', 'mac', 'restoreSkipped'], 'started');
        if (this.startedEvent || (this.command === 'run' && !this.listened)) throw new Error('started out of order');
        if (!Number.isInteger(f.pid) || (f.pid as number) <= 1) throw new Error('started with no pid');
        if (f.boot !== 'cold' && f.boot !== 'restore') throw new Error('started with an unknown boot');
        if (!isCount(f.startMs)) throw new Error('started with no startMs');
        if (f.mac !== undefined && (this.command !== 'provision' || !isText(f.mac, MAC_RE))) throw new Error('started with a malformed mac');
        if (f.restoreSkipped !== undefined && typeof f.restoreSkipped !== 'string') throw new Error('started with a malformed restoreSkipped');
        this.startedEvent = {
          pid: f.pid as number,
          boot: f.boot,
          startMs: f.startMs,
          ...(f.mac !== undefined ? { mac: f.mac as string } : {}),
          ...(f.restoreSkipped !== undefined ? { restoreSkipped: sanitizeGuestText(f.restoreSkipped, 512) } : {}),
        };
        this.emit('started', this.startedEvent);
        return;
      }
      case 'restore':
        pick(f, ['ok', 'message'], 'restore');
        if (f.ok !== false || typeof f.message !== 'string') throw new Error('a restore event that is not a refusal');
        this.opts.log('warn', `the saved state was refused; booting cold: ${sanitizeGuestText(f.message, 512)}`);
        this.emit('restore', sanitizeGuestText(f.message, 512));
        return;
    }
  }

  private onEnd(f: Record<string, unknown>): void {
    const { ok, reason, code, message, ...rest } = f;
    if (!isBool(ok)) throw new Error('an end without ok');
    if (!['done', 'requested', 'guest', 'error'].includes(reason as string)) throw new Error('an end with an unknown reason');
    if (ok === (code !== undefined)) throw new Error('an end whose code does not match ok');
    if (code !== undefined && !isText(code, CODE_RE)) throw new Error('an end with a malformed code');
    if (message !== undefined && typeof message !== 'string') throw new Error('an end with a malformed message');
    const result = ok && reason === 'done' ? checkResult(this.command, rest) : (pick(rest, [], 'an end'), {});
    this.endEvent = {
      ok,
      reason: reason as EndEvent['reason'],
      ...(code !== undefined ? { code: code as string } : {}),
      ...(message !== undefined ? { message: sanitizeGuestText(message, 1024) } : {}),
      result,
    };
    this.emit('end', this.endEvent);
  }

  private onAnswer(answer: Record<string, unknown>): void {
    const id = answer.id;
    const waiting = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (!waiting || typeof answer.ok !== 'boolean') return this.violate('an answer to no command');
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
    let errorCode = this.protocolError ? 'E_HELPER_PROTOCOL' : override ?? exitErrorCode(code, signal);
    // A clean exit is clean only with an ok end before it: without one the
    // helper broke its contract, and with a failed one the end says why.
    if (errorCode === undefined && !this.endEvent) errorCode = 'E_HELPER_PROTOCOL';
    if (errorCode === undefined && this.endEvent && !this.endEvent.ok) errorCode = this.endEvent.code ?? 'E_HELPER_EXIT';
    this.exit = {
      code,
      signal,
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(this.endEvent ? { end: this.endEvent } : {}),
    };
    for (const { reject } of this.pending.values()) reject(new Error('the helper exited'));
    this.pending.clear();
    this.resolveExit(this.exit);
    this.emit('exit', this.exit);
  }
}
