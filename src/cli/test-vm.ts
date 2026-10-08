/**
 * Where `localmost test` runs a workflow's steps: a fresh macOS VM, cloned
 * from the golden image as a runner job's is, booted by the running app and
 * driven from here.
 *
 *   1. A closed port stands in for the broker, which a test run has no use
 *      for: the VM's helper relays to two host ports, and this one leads
 *      nowhere else on the Mac.
 *   2. The app is asked over its CLI socket for a VM (`test-vm`): it boots
 *      one from the same slots as runner jobs and answers with the VM's
 *      agent socket. The VM is this run's until that connection closes.
 *   3. This process dials the agent itself, sends the host's copy of the
 *      checkout into the guest, then each step - with any action it uses -
 *      and reads back each step's output, exit and GITHUB_OUTPUT
 *      (MacVMAgentCore/Steps.swift is the guest's side).
 *
 * The guest has no network device: a step reaches the network only through
 * the run's proxy, relayed to the same 127.0.0.1 port in the guest.
 */

import * as crypto from 'crypto';
import * as net from 'net';
import * as path from 'path';
import * as tar from 'tar';
import {
  GUEST_TEST_ROOT,
  GUEST_WORKSPACE,
  MAX_PUT_BYTES,
  MacAgentClient,
  stepEnvNameAllowed,
  type PutDest,
  type StepRequest,
} from '../main/isolation/macos-vm/agent-client';
import { getCliSocketPath } from '../shared/paths';
import type { StepRunner, RunnerStep, RunnerStepResult } from '../shared/step-executor';

/** What VmStepRunner needs of the agent: MacAgentClient, or a test's fake. */
export interface GuestAgent {
  put(dest: PutDest, bytes: Buffer, sha256: string): Promise<void>;
  step(req: StepRequest): Promise<number>;
  signal(signal: 'TERM' | 'INT' | 'KILL'): Promise<void>;
  on(event: 'output', listener: (stream: 'stdout' | 'stderr', line: string) => void): unknown;
  on(event: 'stepExit', listener: (code: number | null, signal: string | null, outputs: string) => void): unknown;
  on(event: 'closed', listener: (err: Error) => void): unknown;
  close(): void;
}

/** How long the app may take to hand over a VM: a cold boot logs in first, and both slots may be busy. */
const LEASE_TIMEOUT_MS = 15 * 60_000;
/** The longest answer the app sends. */
const MAX_ANSWER_CHARS = 64 * 1024;

/** The signals the agent names (its signalName), by number. */
const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGABRT: 6, SIGKILL: 9, SIGSEGV: 11, SIGTERM: 15 };

/** The step path the guest sees, relative to GUEST_TEST_ROOT, or an error naming `what`. */
function guestRelative(guestPath: string, what: string): string {
  const normal = path.posix.normalize(guestPath);
  if (normal !== guestPath || !normal.startsWith(`${GUEST_TEST_ROOT}/`)) {
    throw new Error(`${what} ${JSON.stringify(guestPath)} is not inside the macOS VM's test run`);
  }
  return normal.slice(GUEST_TEST_ROOT.length + 1);
}

/**
 * A directory as a tar, at most MAX_PUT_BYTES: entries relative to it, links
 * kept as links. node-tar writes the same archive on any host and, unlike
 * macOS's own tar, never adds AppleDouble files or extended attributes;
 * portable leaves out the host's owners, which mean nothing in the guest.
 */
export function tarDirectory(dir: string, maxBytes = MAX_PUT_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.c({ cwd: dir, portable: true, strict: true }, ['.']);
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      pack.destroy();
      reject(err);
    };
    pack.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        return fail(new Error(`${dir} is over ${maxBytes / 2 ** 20} MiB, the most localmost test sends into the macOS VM`));
      }
      chunks.push(chunk);
    });
    pack.on('error', (err: unknown) => fail(new Error(`tar of ${dir} failed: ${(err as Error).message}`)));
    pack.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

/** A test run's steps, run in the guest through its agent. */
export class VmStepRunner implements StepRunner {
  readonly workDir = GUEST_WORKSPACE;
  private readonly provided = new Map<string, Promise<string>>();
  private readonly dropped = new Set<string>();
  private current: { step: RunnerStep; resolve: (r: RunnerStepResult) => void; reject: (e: Error) => void } | null = null;
  private lost: Error | null = null;

  constructor(
    private readonly agent: GuestAgent,
    private readonly opts: { onNote?: (message: string) => void; onClose?: () => void | Promise<void> } = {}
  ) {
    agent.on('output', (stream, line) => this.current?.step.onLine(line, stream));
    agent.on('stepExit', (code, signal, outputs) => {
      const current = this.current;
      this.current = null;
      // A step a signal ended reads as the shell reports one: 128 + its number.
      current?.resolve({ exitCode: code ?? 128 + (SIGNAL_NUMBERS[signal ?? ''] ?? 0), outputs });
    });
    agent.on('closed', (err) => {
      this.lost = new Error(`lost the macOS VM's agent: ${err.message}`);
      const current = this.current;
      this.current = null;
      current?.reject(this.lost);
    });
  }

  /** Sends the host's copy of the checkout in as the guest's workspace. */
  async putWorkspace(hostDir: string): Promise<void> {
    const bytes = await tarDirectory(hostDir);
    await this.agent.put('workspace', bytes, crypto.createHash('sha256').update(bytes).digest('hex'));
  }

  provide(hostDir: string): Promise<string> {
    let guestDir = this.provided.get(hostDir);
    if (!guestDir) {
      guestDir = (async () => {
        const dest: PutDest = `actions/${crypto.randomBytes(8).toString('hex')}`;
        const bytes = await tarDirectory(hostDir);
        await this.agent.put(dest, bytes, crypto.createHash('sha256').update(bytes).digest('hex'));
        return `${GUEST_TEST_ROOT}/${dest}`;
      })();
      this.provided.set(hostDir, guestDir);
      guestDir.catch(() => this.provided.delete(hostDir));
    }
    return guestDir;
  }

  async run(step: RunnerStep): Promise<RunnerStepResult> {
    if (this.lost) throw this.lost;
    if (this.current) throw new Error('a step is already running');
    const cwd = guestRelative(step.cwd, 'working-directory');
    const entry = step.entry === undefined ? undefined : guestRelative(step.entry, 'entry point');
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(step.env)) {
      if (stepEnvNameAllowed(name)) {
        env[name] = value;
      } else if (!this.dropped.has(name)) {
        this.dropped.add(name);
        this.opts.onNote?.(`${name} is not passed to steps in the macOS VM: the guest sets it, or it could change how the step starts`);
      }
    }
    const done = new Promise<RunnerStepResult>((resolve, reject) => {
      this.current = { step, resolve, reject };
    });
    try {
      await this.agent.step({ program: step.program, script: step.script, entry, cwd, env });
    } catch (err) {
      this.current = null;
      throw err;
    }
    return done;
  }

  async endJob(): Promise<void> {
    if (this.lost) return;
    await this.agent.signal('KILL');
  }

  private closing: Promise<void> | null = null;

  /**
   * Ends the run: the agent connection, which kills the steps, then the VM.
   * released() says when the VM is gone.
   */
  close(): void {
    if (this.closing) return;
    this.agent.close();
    this.closing = Promise.resolve(this.opts.onClose?.()).catch(() => undefined);
  }

  /** Resolves once close() has let the VM go, and with it the run's ports. */
  released(): Promise<void> {
    return this.closing ?? Promise.resolve();
  }
}

/** A dry run's runner, which runs nothing: it only has to name the workspace. */
export function dryRunRunner(): StepRunner & { close(): void } {
  const refuse = () => Promise.reject(new Error('a dry run runs no steps'));
  return { workDir: GUEST_WORKSPACE, provide: refuse, run: refuse, endJob: () => Promise.resolve(), close: () => {} };
}

/** A port on 127.0.0.1 that closes every connection: the test run's broker. */
export async function closedPort(): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((conn) => conn.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { port: (server.address() as net.AddressInfo).port, close: () => server.close() };
}

/** How long the run waits for the app to say its VM is gone before it lets its ports go anyway. */
const RELEASE_TIMEOUT_MS = 30_000;

/** A macOS VM the app lent this run. */
export interface TestVmLease {
  agentSocket: string;
  /** Lets the VM go at once, without waiting: for an interrupt, which exits next. */
  release: () => void;
  /**
   * Asks the app to release the VM and resolves once it says the VM is gone,
   * or the connection closes, or `timeoutMs` passes; the connection is
   * closed either way.
   */
  end: (timeoutMs?: number) => Promise<void>;
}

/**
 * Asks the running app for a macOS VM for this run. Resolves with the VM's
 * agent socket and the connection that holds the VM; closing it releases
 * the VM.
 */
export function leaseTestVm(
  ports: { proxyPort: number; brokerPort: number },
  socketPath = getCliSocketPath(),
  timeoutMs = LEASE_TIMEOUT_MS
): Promise<TestVmLease> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let answer = '';
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail('The localmost app did not start a macOS VM in time'), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ command: 'test-vm', args: ports })}\n`);
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        fail('localmost test runs each job in a macOS VM, which the localmost app runs: start it with `localmost start`, then try again.');
      } else {
        fail(`Cannot reach the localmost app: ${err.message}`);
      }
    });
    socket.on('close', () => {
      clearTimeout(timer);
      fail('The localmost app closed the connection before a macOS VM started');
    });
    socket.on('data', (chunk: string) => {
      if (settled) return;
      answer += chunk;
      const nl = answer.indexOf('\n');
      if (nl === -1) {
        if (answer.length > MAX_ANSWER_CHARS) fail('The localmost app sent an answer too long to read');
        return;
      }
      clearTimeout(timer);
      let response: { success?: unknown; command?: unknown; error?: unknown; data?: { agentSocket?: unknown } };
      try {
        response = JSON.parse(answer.slice(0, nl));
      } catch {
        return fail('The localmost app sent an answer that is not JSON');
      }
      if (response.success !== true) {
        const error = typeof response.error === 'string' ? response.error : 'no reason given';
        const hint = /golden macOS image/.test(error)
          ? ' Build it in the localmost app (Settings > macOS VM > Build the golden image), then run localmost test again.'
          : '';
        return fail(`Cannot run the workflow in a macOS VM: ${error}.${hint}`);
      }
      const agentSocket = response.data?.agentSocket;
      if (response.command !== 'test-vm' || typeof agentSocket !== 'string' || !path.isAbsolute(agentSocket)) {
        return fail('The localmost app sent a malformed answer to test-vm');
      }
      settled = true;
      socket.removeAllListeners('close');
      socket.removeAllListeners('data');
      let closed = false;
      const closedListeners: Array<() => void> = [];
      socket.on('close', () => {
        closed = true;
        for (const done of closedListeners.splice(0)) done();
      });
      let ending: Promise<void> | null = null;
      const end = (waitMs = RELEASE_TIMEOUT_MS): Promise<void> => {
        ending ??= new Promise<void>((done) => {
          const finish = () => {
            clearTimeout(timeout);
            socket.destroy();
            done();
          };
          const timeout = setTimeout(finish, waitMs);
          if (closed) return finish();
          closedListeners.push(finish);
          let reply = '';
          socket.on('data', (more: string) => {
            reply += more;
            if (reply.includes('\n') || reply.length > MAX_ANSWER_CHARS) finish();
          });
          socket.write(`${JSON.stringify({ command: 'test-vm-release' })}\n`);
        });
        return ending;
      };
      resolve({ agentSocket, release: () => socket.destroy(), end });
    });
  });
}

/**
 * The VM for one test run, from the app, with the workspace in it: the
 * closed broker port, the lease, and the agent connection, all ended by the
 * runner's close().
 */
export async function openVmStepRunner(opts: {
  proxyPort: number;
  hostWorkDir: string;
  onNote?: (message: string) => void;
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
}): Promise<VmStepRunner> {
  const broker = await closedPort();
  let lease: TestVmLease | null = null;
  let agent: MacAgentClient | null = null;
  try {
    lease = await leaseTestVm({ proxyPort: opts.proxyPort, brokerPort: broker.port });
    agent = new MacAgentClient({ socketPath: lease.agentSocket, log: opts.log });
    await agent.connect();
    const held = lease;
    const runner = new VmStepRunner(agent, {
      onNote: opts.onNote,
      // The broker port stays this run's until the app says the VM is gone:
      // let go sooner, another process could take the port the VM's broker
      // relay still leads to.
      onClose: async () => {
        await held.end();
        broker.close();
      },
    });
    await runner.putWorkspace(opts.hostWorkDir);
    return runner;
  } catch (err) {
    agent?.close();
    lease?.release();
    broker.close();
    throw err;
  }
}
