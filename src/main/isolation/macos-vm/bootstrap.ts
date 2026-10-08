/**
 * The golden image's one-time setup, run over SSH while the provisioning VM
 * is up with Remote Login on: the agent binary and the runner copied into
 * the administrator's home, then `sudo localmost-macvm-agent setup` with its
 * inputs on stdin (MacVMAgentCore/Setup.swift has the steps). The setup ends
 * by giving the administrator a password nobody keeps, turning Remote Login
 * off and shutting the guest down.
 *
 * The administrator's password reaches ssh only through SSH_ASKPASS, a
 * script in the image's 0700 bootstrap directory that prints a 0600 file
 * beside it; it is never on a command line, and sudo reads it from stdin.
 * ssh reads no configuration of the user's (-F /dev/null), offers no key or
 * agent of the user's, and keeps the guest's host key in the bootstrap
 * directory: the guest is new, so its first key is taken, and any other key
 * after that is refused. Both files are removed when the setup ends.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { lineSplitter, parseFrame, sanitizeGuestText } from '../../vm/ndjson';
import { isPrivateIPv4 } from './dhcp-leases';

export const ACCOUNT_NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/;

export interface SetupAccount {
  username: string;
  fullName: string;
  password: string;
}

export interface SetupInputs {
  /** The job user's password, kept only in the guest's /etc/kcpassword for auto-login. */
  jobPassword: string;
  /** What the administrator's password becomes at the end; nobody keeps it. */
  discardedAdminPassword: string;
  runnerVersion: string;
  osVersion: string;
  osBuild: string;
}

/** Runs ssh: `args` after the program name, `input` on its stdin, each stdout line to `onLine`. */
export type SshRunner = (
  args: string[],
  env: Record<string, string>,
  input: Buffer | null,
  onLine: (line: string) => void,
  signal?: AbortSignal
) => Promise<{ code: number | null; stderr: string }>;

export const defaultSshRunner: SshRunner = (args, env, input, onLine, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/ssh', args, { env, stdio: ['pipe', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    let stderr = '';
    child.stdout.on('data', lineSplitter(onLine, () => {}));
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });

export interface BootstrapOptions {
  ip: string;
  account: SetupAccount;
  /** `<data>/macos-vm/bootstrap/<imageId>`, made 0700 by the caller. */
  dir: string;
  agentBinary: string;
  /** The runner, packed as a tar.gz by the caller. */
  runnerTarball: string;
  inputs: SetupInputs;
  onStep?: (index: number, of: number, what: string) => void;
  /** Each wait for Remote Login: the seconds elapsed and what the last probe saw. */
  onWaiting?: (elapsedSec: number, probe: string) => void;
  /**
   * Re-reads the guest's address from the DHCP leases by its MAC. The first
   * boot can reboot (provisioning, the "Setting up your Mac" phase), and vmnet
   * may hand the same MAC a different lease, so each probe follows the address
   * rather than trusting the one the VM leased first.
   */
  resolveIp?: () => string | null;
  log: (level: 'info' | 'warn', message: string) => void;
  signal?: AbortSignal;
  ssh?: SshRunner;
  /** How long to wait for Remote Login to answer. */
  reachableTimeoutMs?: number;
  /** Between tries while waiting. */
  retryMs?: number;
  /** Injected for tests. */
  now?: () => number;
}

/** Where the setup's files go in the guest: the administrator's own home. */
const REMOTE_DIR = 'localmost-setup';

/** ssh's arguments for one command on the guest. */
export function sshArgs(dir: string, username: string, ip: string, remoteCommand: string): string[] {
  if (!ACCOUNT_NAME_RE.test(username)) throw new Error(`not an account name: ${JSON.stringify(username)}`);
  if (!isPrivateIPv4(ip)) throw new Error(`not a private address: ${JSON.stringify(ip)}`);
  return [
    '-F', '/dev/null',
    '-o', 'BatchMode=no',
    '-o', 'PreferredAuthentications=keyboard-interactive,password',
    '-o', 'PubkeyAuthentication=no',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none',
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${path.join(dir, 'known_hosts')}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'LogLevel=ERROR',
    '-T',
    '-l', username,
    ip,
    remoteCommand,
  ];
}

/** The environment ssh runs with: the askpass, and nothing of the user's. */
export function sshEnv(dir: string): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    HOME: dir,
    SSH_ASKPASS: path.join(dir, 'askpass'),
    SSH_ASKPASS_REQUIRE: 'force',
  };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('the setup was cancelled'))), { once: true });
  });

/** Writes a file without following a link at its name, replacing nothing. */
function writeNew(file: string, contents: string, mode: number): void {
  fs.rmSync(file, { force: true });
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try {
    fs.writeSync(fd, contents);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Runs the setup. Resolves once the guest reports it done (the guest then
 * shuts itself down); rejects with the step that failed.
 */
export async function runBootstrap(opts: BootstrapOptions): Promise<void> {
  const ssh = opts.ssh ?? defaultSshRunner;
  const now = opts.now ?? Date.now;
  const { username, password } = opts.account;
  const passwordFile = path.join(opts.dir, 'password');
  const askpass = path.join(opts.dir, 'askpass');
  const st = fs.lstatSync(opts.dir);
  if (!st.isDirectory() || (st.mode & 0o077) !== 0) throw new Error(`${opts.dir} must be a directory only its owner can reach`);
  writeNew(passwordFile, `${password}\n`, 0o600);
  writeNew(askpass, `#!/bin/sh\nexec /bin/cat '${passwordFile.replace(/'/g, `'\\''`)}'\n`, 0o700);
  const env = sshEnv(opts.dir);
  let ip = opts.ip;
  const run = (command: string, input: Buffer | null, onLine: (line: string) => void = () => {}) =>
    ssh(sshArgs(opts.dir, username, ip, command), env, input, onLine, opts.signal);
  try {
    // Remote Login answers once the guest is up and, on the guided path,
    // once the operator has turned it on. The first boot can take many
    // minutes and can reboot, so each probe re-resolves the address and logs
    // what it saw with the seconds elapsed: the only window onto a wait that
    // was otherwise silent for the whole timeout.
    const start = now();
    const deadline = start + (opts.reachableTimeoutMs ?? 60 * 60_000);
    let lastProbe = '';
    let heartbeat = start;
    for (;;) {
      const resolved = opts.resolveIp?.();
      if (resolved && resolved !== ip && isPrivateIPv4(resolved)) {
        opts.log('info', `the VM's address changed from ${ip} to ${resolved}; following it`);
        ip = resolved;
        lastProbe = '';
      }
      const probe = await run('/usr/bin/true', null);
      const elapsedSec = Math.round((now() - start) / 1000);
      if (probe.code === 0) {
        opts.log('info', `Remote Login answered on ${ip} after ${elapsedSec} s; copying the agent and the runner`);
        break;
      }
      if (now() > deadline) {
        throw new Error(`Remote Login on ${ip} did not answer within ${Math.round((now() - start) / 60_000)} min: ${sanitizeGuestText(probe.stderr, 300)}`);
      }
      const klass = classifyReachStderr(probe.stderr);
      if (klass !== lastProbe) {
        opts.log('info', `Remote Login on ${ip}: ${klass} at ${elapsedSec} s`);
        lastProbe = klass;
        heartbeat = now();
      } else if (now() - heartbeat >= 60_000) {
        opts.log('info', `Remote Login on ${ip}: still ${klass} at ${elapsedSec} s`);
        heartbeat = now();
      }
      opts.onWaiting?.(elapsedSec, klass);
      await sleep(opts.retryMs ?? 10_000, opts.signal);
    }
    const copy = async (local: string, name: string, mode: string) => {
      const result = await run(
        `/bin/mkdir -p -m 700 ${REMOTE_DIR} && /bin/cat > ${REMOTE_DIR}/${name} && /bin/chmod ${mode} ${REMOTE_DIR}/${name}`,
        fs.readFileSync(local)
      );
      if (result.code !== 0) throw new Error(`copying ${name} into the guest failed: ${sanitizeGuestText(result.stderr, 300)}`);
    };
    await copy(opts.agentBinary, 'localmost-macvm-agent', '755');
    await copy(opts.runnerTarball, 'runner.tar.gz', '644');

    const home = `/Users/${username}`;
    const inputs = {
      adminUser: username,
      adminPassword: password,
      jobPassword: opts.inputs.jobPassword,
      discardedAdminPassword: opts.inputs.discardedAdminPassword,
      runnerVersion: opts.inputs.runnerVersion,
      runnerTarball: `${home}/${REMOTE_DIR}/runner.tar.gz`,
      agentBinary: `${home}/${REMOTE_DIR}/localmost-macvm-agent`,
      osVersion: opts.inputs.osVersion,
      osBuild: opts.inputs.osBuild,
    };
    // sudo -S reads its password up to the newline; the setup reads the rest.
    const stdin = Buffer.from(`${password}\n${JSON.stringify(inputs)}`);
    let done = false;
    let failure: string | null = null;
    const result = await run(`/usr/bin/sudo -S -p '' ${home}/${REMOTE_DIR}/localmost-macvm-agent setup`, stdin, (line) => {
      const event = parseFrame(line);
      if (!event) return;
      if (event.event === 'step' && Number.isInteger(event.index) && Number.isInteger(event.of) && typeof event.what === 'string') {
        opts.onStep?.(event.index as number, event.of as number, sanitizeGuestText(event.what, 200));
      } else if (event.event === 'failed') {
        failure = sanitizeGuestText(event.message ?? 'no reason given', 500);
      } else if (event.event === 'done') {
        done = true;
      }
    });
    if (failure) throw new Error(`the guest's setup failed: ${failure}`);
    if (!done) throw new Error(`the guest's setup ended without finishing (exit ${result.code}): ${sanitizeGuestText(result.stderr, 300)}`);
  } finally {
    fs.rmSync(passwordFile, { force: true });
    fs.rmSync(askpass, { force: true });
  }
}

/**
 * A short, stable class for an ssh probe's stderr, so the reachable-wait can
 * log the guest's boot crossing each threshold: no route (the guest is not on
 * the network yet) -> TCP refused (it is, but sshd is not listening) -> auth
 * refused (sshd answers, but the account is not ready) -> answered.
 */
export function classifyReachStderr(stderr: string): string {
  const s = stderr.toLowerCase();
  if (/no route to host|network is unreachable|host is down/.test(s)) return 'no route (guest not on the network yet)';
  if (/connection refused/.test(s)) return 'TCP refused (sshd not listening yet)';
  if (/operation timed out|connection timed out|timed out/.test(s)) return 'timed out (no answer)';
  if (/connection reset|broken pipe/.test(s)) return 'connection reset';
  if (/permission denied|authenticat|too many authentication/.test(s)) return 'auth refused (account not ready yet)';
  return 'not answering';
}

/** A password from an alphabet with no look-alikes, in groups of four: readable, and typed by hand in the guided setup. */
export function readablePassword(random: (n: number) => Buffer, groups = 5): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const out: string[] = [];
  for (let g = 0; g < groups; g++) {
    let group = '';
    while (group.length < 4) {
      const byte = random(1)[0];
      // Rejection sampling, so every character is equally likely.
      if (byte < Math.floor(256 / alphabet.length) * alphabet.length) group += alphabet[byte % alphabet.length];
    }
    out.push(group);
  }
  return out.join('-');
}
