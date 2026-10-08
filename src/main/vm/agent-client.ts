/**
 * The guest agent's control protocol over the helper's agent.sock (contract
 * §3.4): one connection, requests answered in order, each with a timeout.
 *
 * The agent runs as root in a guest whose containers are the job's, so every
 * answer is hostile input. Each is matched to a request by id, checked
 * against the op's schema, and bounded before anything uses it; a field of
 * the wrong type, an oversized string or an id no request carries closes the
 * connection. The agent's error messages are guest text: stripped of control
 * characters and capped before they are logged or returned. Nothing an
 * answer says ever chooses a host path.
 */

import * as net from 'net';
import type { ApprovedBind } from '../docker/docker-backend';
import type {
  AgentClient,
  AgentConfigureRequest,
  AgentConfigureResult,
  AgentErrorCode,
  AgentHello,
  AgentStatus,
  RosettaState,
} from './types';
import { frame, lineSplitter, parseFrame, sanitizeGuestText } from './ndjson';

/** How long each op may take (§3.4). */
export const AGENT_TIMEOUTS_MS = {
  hello: 5_000,
  configure: 60_000,
  'approve-binds': 10_000,
  'set-time': 10_000,
  status: 10_000,
  shutdown: 10_000,
} as const;
type Op = keyof typeof AGENT_TIMEOUTS_MS;

const AGENT_ERROR_CODES: ReadonlySet<string> = new Set<AgentErrorCode>([
  'E_PROTO', 'E_UNKNOWN_OP', 'E_CONFIGURED', 'E_NOT_CONFIGURED', 'E_DISK',
  'E_SHARE_PATH', 'E_SHARE_MOUNT', 'E_DOCKERD', 'E_SELFTEST', 'E_BINDS',
]);

/** At most this many binds per approval (§3.4). */
export const MAX_APPROVED_BINDS = 64;

/** A refusal from the agent (its own code), or the client's: a timeout, a closed or broken connection. */
export class AgentClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** A string the agent sent, of at most `max` characters and no control characters. */
function text(value: unknown, what: string, max: number, form?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`${what} is not a string of at most ${max} plain characters`);
  }
  if (form && !form.test(value)) throw new Error(`${what} is not of its form`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (!allowed.includes(value as T)) throw new Error(`${what} is not one of ${allowed.join(', ')}`);
  return value as T;
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${what} is not a boolean`);
  return value;
}

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${what} is not an object`);
  return value as Record<string, unknown>;
};

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
const API_RE = /^[0-9]{1,3}\.[0-9]{1,3}$/;

const readHello = (a: Record<string, unknown>): AgentHello => {
  if (a.agentProtocol !== 1) throw new Error('agentProtocol is not 1');
  return {
    agent: text(a.agent, 'agent', 64, VERSION_RE),
    guestVersion: text(a.guestVersion, 'guestVersion', 64, VERSION_RE),
    kernel: text(a.kernel, 'kernel', 128, VERSION_RE),
    agentProtocol: 1,
  };
};

const readConfigure = (a: Record<string, unknown>, mode: 'job' | 'refresh'): AgentConfigureResult => {
  const docker = record(a.docker, 'docker');
  const selftest = record(a.selftest, 'selftest');
  const result: AgentConfigureResult = {
    docker: {
      version: text(docker.version, 'docker.version', 64, VERSION_RE),
      apiVersion: text(docker.apiVersion, 'docker.apiVersion', 7, API_RE),
      minApiVersion: text(docker.minApiVersion, 'docker.minApiVersion', 7, API_RE),
    },
    disk: oneOf(a.disk, ['formatted', 'existing', 'corrupt'] as const, 'disk'),
    rosetta: oneOf<RosettaState>(a.rosetta, ['ok', 'absent', 'broken'], 'rosetta'),
    selftest: {
      rules: bool(selftest.rules, 'selftest.rules'),
      internalNoRelay: bool(selftest.internalNoRelay, 'selftest.internalNoRelay'),
      internalForgedRejected: bool(selftest.internalForgedRejected, 'selftest.internalForgedRejected'),
      gatewayRejected: bool(selftest.gatewayRejected, 'selftest.gatewayRejected'),
      bridgeReachesRelay: bool(selftest.bridgeReachesRelay, 'selftest.bridgeReachesRelay'),
      outsideRejected: bool(selftest.outsideRejected, 'selftest.outsideRejected'),
    },
  };
  if (mode === 'job') {
    // What the guest read from the share's nonce file: at most 64 characters,
    // compared by the manager with the nonce Electron wrote.
    if (typeof a.nonce !== 'string' || a.nonce.length > 64) throw new Error('nonce is not a string of at most 64 characters');
    result.nonce = a.nonce;
  }
  return result;
};

const readStatus = (a: Record<string, unknown>): AgentStatus => {
  const uptimeMs = a.uptimeMs;
  if (typeof uptimeMs !== 'number' || !Number.isFinite(uptimeMs) || uptimeMs < 0) throw new Error('uptimeMs is not a duration');
  return { dockerd: oneOf(a.dockerd, ['running', 'exited'] as const, 'dockerd'), uptimeMs };
};

interface Pending {
  op: Op;
  resolve: (answer: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface AgentClientOptions {
  /** The VM's agent.sock. */
  socketPath: string;
  /** Guest text reaches this only sanitized. */
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
  /** Per-op timeouts, for tests; the §3.4 ones by default. */
  timeoutsMs?: Partial<Record<Op, number>>;
}

/** §3.4 over one connection to the helper's agent.sock. */
export class UnixAgentClient implements AgentClient {
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private closed: AgentClientError | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Requests that timed out: an answer to one arriving late is dropped, not a violation. */
  private readonly expired = new Set<number>();

  constructor(private readonly opts: AgentClientOptions) {}

  /**
   * Open the connection. The helper accepts on agent.sock and then dials the
   * guest; until the agent listens, it closes the connection at once, so a
   * caller retries hello on a new client until the agent answers.
   */
  connect(): Promise<void> {
    this.connecting ??= new Promise((resolve, reject) => {
      const socket = net.connect(this.opts.socketPath);
      this.socket = socket;
      socket.once('connect', () => resolve());
      socket.on('error', (err) => {
        reject(new AgentClientError('E_AGENT_CLOSED', `cannot reach the guest agent: ${err.message}`));
        this.fail(new AgentClientError('E_AGENT_CLOSED', `the connection to the guest agent failed: ${err.message}`));
      });
      socket.on('close', () => {
        reject(new AgentClientError('E_AGENT_CLOSED', 'the guest agent closed the connection'));
        this.fail(new AgentClientError('E_AGENT_CLOSED', 'the guest agent closed the connection'));
      });
      socket.on('data', lineSplitter((line) => this.onLine(line), () => this.violate('an answer over 64 KiB')));
    });
    return this.connecting;
  }

  async hello(): Promise<AgentHello> {
    return this.checked('hello', {}, readHello);
  }

  async configure(req: AgentConfigureRequest): Promise<AgentConfigureResult> {
    return this.checked('configure', { ...req }, (a) => readConfigure(a, req.mode));
  }

  async approveBinds(container: string, binds: ApprovedBind[]): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(container)) throw new AgentClientError('E_BINDS', 'a container id is 64 hex');
    if (binds.length > MAX_APPROVED_BINDS) {
      throw new AgentClientError('E_BINDS', `a container may have at most ${MAX_APPROVED_BINDS} approved binds`);
    }
    const clean = binds.map(({ source, destination, readOnly }) => ({ source, destination, readOnly: readOnly === true }));
    await this.checked('approve-binds', { container, binds: clean }, () => undefined);
  }

  async setTime(unixMs: number): Promise<void> {
    await this.checked('set-time', { unixMs: Math.floor(unixMs) }, () => undefined);
  }

  async status(): Promise<AgentStatus> {
    return this.checked('status', {}, readStatus);
  }

  async shutdown(): Promise<void> {
    await this.checked('shutdown', {}, () => undefined);
  }

  close(): void {
    this.fail(new AgentClientError('E_AGENT_CLOSED', 'the connection to the guest agent was closed'));
  }

  private async checked<T>(op: Op, fields: Record<string, unknown>, read: (answer: Record<string, unknown>) => T): Promise<T> {
    const answer = await this.request(op, fields);
    try {
      return read(answer);
    } catch (err) {
      const violation = `the guest agent's ${op} answer is malformed: ${sanitizeGuestText((err as Error).message, 200)}`;
      this.violate(violation);
      throw new AgentClientError('E_AGENT_PROTOCOL', violation);
    }
  }

  private async request(op: Op, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.connect();
    if (this.closed) throw this.closed;
    const socket = this.socket!;
    const id = this.nextId++;
    const timeoutMs = this.opts.timeoutsMs?.[op] ?? AGENT_TIMEOUTS_MS[op];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.expired.add(id);
        reject(new AgentClientError('E_AGENT_TIMEOUT', `the guest agent did not answer ${op} in ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { op, resolve, reject, timer });
      socket.write(frame({ id, op, ...fields }));
    });
  }

  private onLine(line: string): void {
    const answer = parseFrame(line);
    if (!answer || typeof answer.id !== 'number' || typeof answer.ok !== 'boolean') {
      this.violate('a line that is not an answer');
      return;
    }
    const id = answer.id;
    if (this.expired.delete(id)) {
      this.opts.log?.('debug', `dropped the late answer to request ${id}, which had timed out`);
      return;
    }
    const waiting = this.pending.get(id);
    if (!waiting) {
      this.violate(`an answer to request ${id}, which is not waiting`);
      return;
    }
    this.pending.delete(id);
    clearTimeout(waiting.timer);
    if (answer.ok) {
      waiting.resolve(answer);
      return;
    }
    const code = typeof answer.code === 'string' && AGENT_ERROR_CODES.has(answer.code) ? answer.code : 'E_AGENT_UNKNOWN';
    const message = sanitizeGuestText(answer.message ?? '', 4096);
    this.opts.log?.('warn', `the guest agent refused ${waiting.op} (${code}): ${message}`);
    waiting.reject(new AgentClientError(code, message));
  }

  /** The agent broke the protocol: nothing more is read from it. */
  private violate(what: string): void {
    this.opts.log?.('warn', `the guest agent broke its protocol (${what}); closing the connection`);
    this.fail(new AgentClientError('E_AGENT_PROTOCOL', `the guest agent broke its protocol: ${what}`));
  }

  private fail(err: AgentClientError): void {
    if (this.closed) return;
    this.closed = err;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
    this.socket?.destroy();
  }
}
