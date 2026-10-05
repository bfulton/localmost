/**
 * The macOS guest agent's protocol, over the helper's agent.sock and vsock
 * port 1025 (native/localmost-macvm, MacVMAgentCore/Protocol.swift is the
 * other side):
 *
 *   agent:    {"event":"hello","agent":"1.0.0","ready":true,"os":"26.6.2","runnerVersions":["2.330.0"]}
 *   Electron: {"id":1,"op":"prepare","timeMs":...,"entropy":"<base64>","proxyPort":p,"brokerPort":b}
 *   Electron: {"id":2,"op":"runner","version":"2.330.0","bytes":n,"sha256":"<hex>"}  then n raw bytes
 *   Electron: {"id":3,"op":"job","runnerVersion":"2.330.0","files":{...},"env":{...},"args":["--once"]}
 *   agent:    {"event":"output","stream":"stdout","data":"..."} ... {"event":"exit","code":0,"signal":null}
 *   Electron: {"id":4,"op":"signal","signal":"TERM"}
 *
 * The agent runs as root in a guest that is the job's, so everything it says
 * is hostile input: each line is matched to a request by id or to an event
 * this client expects, checked field by field and bounded, and anything else
 * closes the connection. Guest text reaches a log or a caller only stripped
 * of control characters. Nothing it says ever chooses a host path.
 */

import { EventEmitter } from 'events';
import * as net from 'net';
import { frame, lineSplitter, parseFrame, sanitizeGuestText } from '../../vm/ndjson';

export const AGENT_TIMEOUTS_MS = {
  hello: 10_000,
  ping: 10_000,
  prepare: 30_000,
  runner: 300_000,
  job: 60_000,
  signal: 10_000,
} as const;
type Op = Exclude<keyof typeof AGENT_TIMEOUTS_MS, 'hello'>;

export class MacAgentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface MacAgentHello {
  agent: string;
  /** Set up, and nothing of a job has reached this boot yet. */
  ready: boolean;
  os: string;
  runnerVersions: string[];
}

export interface PrepareRequest {
  timeMs: number;
  /** 32-512 bytes from the host's CSPRNG, mixed into the guest's pool. */
  entropy: Buffer;
  proxyPort: number;
  brokerPort: number;
}

/** The runner files a job carries: exactly these (MacVMAgentCore.jobFileNames). */
export const JOB_FILE_NAMES = ['.runner', '.credentials', '.credentials_rsaparams'] as const;
export type JobFiles = Record<(typeof JOB_FILE_NAMES)[number], string>;

/** The environment a job's runner may be given (MacVMAgentCore.jobEnvNames). */
export const JOB_ENV_NAMES: ReadonlySet<string> = new Set([
  'ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT', 'DOTNET_SYSTEM_NET_DISABLEIPV6',
  'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY',
  'LANG', 'LC_ALL', 'TZ', 'RUNNER_DEBUG', 'ACTIONS_RUNNER_DEBUG', 'ACTIONS_STEP_DEBUG',
]);

export interface JobRequest {
  runnerVersion: string;
  files: JobFiles;
  env: Record<string, string>;
  args: string[];
}

const VERSION_RE = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;
const OS_RE = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/;
const SIGNAL_RE = /^SIG[A-Z0-9]{1,8}$/;
/** The agent cuts an output line at 16 KiB; a little more for its JSON escaping. */
const MAX_OUTPUT_CHARS = 20_000;

interface Pending {
  op: Op;
  resolve: (answer: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface MacAgentClientOptions {
  socketPath: string;
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
  timeoutsMs?: Partial<typeof AGENT_TIMEOUTS_MS>;
}

/**
 * One control connection. Emits `output` (stream, line) and `exit` (code,
 * signal) for the job it started, and `closed` (MacAgentError) once.
 */
export class MacAgentClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private closed: MacAgentError | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private helloValue: MacAgentHello | null = null;
  private helloWaiters: Array<{ resolve: (h: MacAgentHello) => void; reject: (e: Error) => void }> = [];
  /** The upload in flight: its id, once the agent said to send. */
  private uploading: { id: number; bytes: Buffer; sent: boolean } | null = null;
  private jobStarted = false;
  private exited = false;

  constructor(private readonly opts: MacAgentClientOptions) {
    super();
  }

  private timeout(op: keyof typeof AGENT_TIMEOUTS_MS): number {
    return this.opts.timeoutsMs?.[op] ?? AGENT_TIMEOUTS_MS[op];
  }

  /**
   * Connects and waits for the agent's hello. The helper accepts on
   * agent.sock and then dials the guest; until the agent listens it closes
   * the connection at once, so a caller retries on a new client.
   */
  connect(): Promise<MacAgentHello> {
    if (this.socket) throw new Error('already connected');
    const socket = net.connect(this.opts.socketPath);
    this.socket = socket;
    socket.on('data', lineSplitter((line) => this.onLine(line), () => this.violate('a line over 64 KiB')));
    socket.on('error', (err) => this.fail(new MacAgentError('E_AGENT_CLOSED', `the connection to the guest agent failed: ${err.message}`)));
    socket.on('close', () => this.fail(new MacAgentError('E_AGENT_CLOSED', 'the guest agent closed the connection')));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new MacAgentError('E_AGENT_TIMEOUT', `the guest agent did not say hello in ${this.timeout('hello') / 1000}s`));
      }, this.timeout('hello'));
      this.helloWaiters.push({
        resolve: (h) => (clearTimeout(timer), resolve(h)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }

  hello(): MacAgentHello | null {
    return this.helloValue;
  }

  async ping(): Promise<{ jobStarted: boolean }> {
    const a = await this.request('ping', {});
    if (typeof a.jobStarted !== 'boolean') throw this.malformed('ping');
    return { jobStarted: a.jobStarted };
  }

  async prepare(req: PrepareRequest): Promise<void> {
    if (req.entropy.length < 32 || req.entropy.length > 512) throw new Error('entropy must be 32-512 bytes');
    await this.request('prepare', {
      timeMs: Math.floor(req.timeMs),
      entropy: req.entropy.toString('base64'),
      proxyPort: req.proxyPort,
      brokerPort: req.brokerPort,
    });
  }

  /** Uploads a runner tar.gz; resolves once the agent installed it. */
  async uploadRunner(version: string, bytes: Buffer, sha256: string): Promise<void> {
    if (!VERSION_RE.test(version)) throw new Error(`not a runner version: ${JSON.stringify(version)}`);
    if (this.uploading) throw new Error('an upload is already in flight');
    const a = await this.request('runner', { version, bytes: bytes.length, sha256 }, (id) => {
      this.uploading = { id, bytes, sent: false };
    });
    if (a.installed !== version) throw this.malformed('runner');
  }

  /** Starts the job's runner; resolves with its pid in the guest. */
  async job(req: JobRequest): Promise<number> {
    const a = await this.request('job', { runnerVersion: req.runnerVersion, files: req.files, env: req.env, args: req.args });
    if (!Number.isInteger(a.pid) || (a.pid as number) <= 1) throw this.malformed('job');
    this.jobStarted = true;
    return a.pid as number;
  }

  async signal(signal: 'TERM' | 'INT' | 'KILL'): Promise<void> {
    await this.request('signal', { signal });
  }

  close(): void {
    this.fail(new MacAgentError('E_AGENT_CLOSED', 'the connection to the guest agent was closed'));
  }

  private malformed(op: string): MacAgentError {
    const err = new MacAgentError('E_AGENT_PROTOCOL', `the guest agent's ${op} answer is malformed`);
    this.violate(err.message);
    return err;
  }

  private request(op: Op, fields: Record<string, unknown>, onSent?: (id: number) => void): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(this.closed);
    if (!this.socket || !this.helloValue) return Promise.reject(new MacAgentError('E_AGENT_CLOSED', 'not connected to the guest agent'));
    const id = this.nextId++;
    const timeoutMs = this.timeout(op);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A request that timed out leaves the protocol's order unknown: the
        // connection goes, and every request on it, this one included.
        this.fail(new MacAgentError('E_AGENT_TIMEOUT', `the guest agent did not answer ${op} in ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { op, resolve, reject, timer });
      onSent?.(id);
      this.socket!.write(frame({ id, op, ...fields }));
    });
  }

  private onLine(line: string): void {
    if (this.closed) return;
    const msg = parseFrame(line);
    if (!msg) return this.violate('a line that is not a JSON object with "v":1');
    if (msg.event !== undefined) return this.onEvent(msg);
    const id = msg.id;
    const waiting = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (!waiting || typeof msg.ok !== 'boolean') return this.violate('an answer to no request');
    if (!msg.ok) {
      this.pending.delete(id as number);
      clearTimeout(waiting.timer);
      if (this.uploading?.id === id) this.uploading = null;
      const message = sanitizeGuestText(msg.message ?? '', 1024);
      this.opts.log?.('warn', `the guest agent refused ${waiting.op}: ${message}`);
      waiting.reject(new MacAgentError('E_AGENT_REFUSED', message));
      return;
    }
    // An upload is answered twice: "send", then "installed".
    const upload = this.uploading;
    if (upload && upload.id === id && !upload.sent) {
      if (msg.send !== true) return this.violate('a runner answer without send');
      upload.sent = true;
      this.socket?.write(upload.bytes);
      return;
    }
    if (upload && upload.id === id) this.uploading = null;
    this.pending.delete(id as number);
    clearTimeout(waiting.timer);
    // The job's output can follow its answer in the same read, before the
    // caller's await resumes: it counts as started from its answer.
    if (waiting.op === 'job') this.jobStarted = true;
    waiting.resolve(msg);
  }

  private onEvent(msg: Record<string, unknown>): void {
    switch (msg.event) {
      case 'hello': {
        if (this.helloValue) return this.violate('a second hello');
        const versions = msg.runnerVersions;
        if (
          typeof msg.agent !== 'string' || !VERSION_RE.test(msg.agent) || typeof msg.ready !== 'boolean' ||
          typeof msg.os !== 'string' || !OS_RE.test(msg.os) || !Array.isArray(versions) || versions.length > 16 ||
          !versions.every((v) => typeof v === 'string' && VERSION_RE.test(v))
        ) {
          return this.violate('a malformed hello');
        }
        this.helloValue = { agent: msg.agent, ready: msg.ready, os: msg.os, runnerVersions: versions as string[] };
        for (const w of this.helloWaiters.splice(0)) w.resolve(this.helloValue);
        return;
      }
      case 'output': {
        if (!this.jobStarted || this.exited) return this.violate('output from no job');
        if ((msg.stream !== 'stdout' && msg.stream !== 'stderr') || typeof msg.data !== 'string' || msg.data.length > MAX_OUTPUT_CHARS) {
          return this.violate('malformed output');
        }
        this.emit('output', msg.stream, sanitizeGuestText(msg.data, MAX_OUTPUT_CHARS));
        return;
      }
      case 'exit': {
        if (!this.jobStarted || this.exited) return this.violate('an exit of no job');
        const code = msg.code;
        const signal = msg.signal;
        const codeOk = code === null || (Number.isInteger(code) && (code as number) >= 0 && (code as number) <= 255);
        const signalOk = signal === null || (typeof signal === 'string' && SIGNAL_RE.test(signal));
        if (!codeOk || !signalOk || (code === null) === (signal === null)) return this.violate('a malformed exit');
        this.exited = true;
        this.emit('exit', code as number | null, signal as string | null);
        return;
      }
      case 'error':
        this.opts.log?.('warn', `the guest agent reported: ${sanitizeGuestText(msg.message ?? '', 512)}`);
        return;
      default:
        this.violate('an unknown event');
    }
  }

  private violate(what: string): void {
    this.opts.log?.('warn', `the guest agent broke its protocol (${what}); closing the connection`);
    this.fail(new MacAgentError('E_AGENT_PROTOCOL', `the guest agent broke its protocol: ${what}`));
  }

  private fail(err: MacAgentError): void {
    if (this.closed) return;
    this.closed = err;
    for (const w of this.helloWaiters.splice(0)) w.reject(err);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
    this.socket?.destroy();
    this.emit('closed', err);
  }
}
