#!/usr/bin/env node
/**
 * A stand-in for the localmost-vm helper (contract §8), for tests of the
 * Electron side. Unit tests run it directly through HelperClient's injected
 * spawn, never through sandbox-exec.
 *
 * It takes the §2.1 argument line and applies the same checks, with the same
 * exit codes. It binds docker.sock and agent.sock in the VM's directory, emits
 * the §2.4 events, answers the §2.4 commands, and exits when its stdin closes
 * or on SIGTERM, as the real helper does. Instead of a guest:
 *
 *   docker.sock   each connection is piped to FAKE_DOCKERD_SOCKET, a mock
 *                 daemon the test runs; closed at once when there is none.
 *   agent.sock    answers the §3.4 ops, as scripted by FAKE_AGENT_SCRIPT.
 *
 * FAKE_AGENT_SCRIPT is JSON. Each op name maps to how it is answered:
 *   { "answer": {...} }            fields merged into the default ok answer
 *   { "error": { "code", "message" } }
 *   { "delayMs": n }               answer after n ms
 *   { "raw": "text" }              send this line instead of an answer
 *   { "close": true }              close the connection instead
 * and the key "helper" scripts the helper itself:
 *   { "exitAfterListening": code } exit with code after `listening`
 *   { "stdout": ["line", ...] }    extra stdout lines after `started`
 *   { "rosetta": "installed" }     the `started` rosetta value (default notInstalled)
 *   { "agentAfterMs": n }          agent.sock connections are closed until n ms after start
 *   { "stopExitCode": n }          the exit code after a stop or SIGTERM (default 0)
 *   { "stopDelayMs": n }           how long a stop takes
 *   { "ignoreSigterm": true }      only SIGKILL ends it
 *
 * SIGUSR2 is the guest powering off by itself (`stopped` reason `guest`), at
 * the moment a test chooses rather than after a delay a loaded machine may
 * not keep to.
 *
 * What it is told is written to stderr as `info <what>` lines, which the
 * client logs, so a test can see a stop's grace, a set-time or an approval.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

const started = Date.now();
const script = process.env.FAKE_AGENT_SCRIPT ? JSON.parse(process.env.FAKE_AGENT_SCRIPT) : {};
const helper = script.helper ?? {};

const EXIT = { E_ARGS: 64, E_SHARE: 65, E_GUEST_IMAGE: 66, E_DISK: 67, E_VZ_START: 69, E_SOCKET: 70 };
const ID_RE = /^(?:0|[1-9][0-9]?)-[0-9a-f]{12}$/;
const REPO_KEY_RE = /^[0-9a-f]{16}$/;

const log = (level, message) => process.stderr.write(`${level} ${message}\n`);
const emit = (body) => process.stdout.write(`${JSON.stringify({ v: 1, ...body })}\n`);
function fail(code, message) {
  log('error', `${code}: ${message}`);
  process.exit(EXIT[code]);
}

// --- Arguments (§2.1) --------------------------------------------------------

const argv = process.argv.slice(2);
if (argv[0] === 'version' && argv.length === 1) {
  process.stdout.write(`${JSON.stringify({ helper: '0.0.0-fake', contract: 1 })}\n`);
  process.exit(0);
}
if (argv[0] !== 'run') fail('E_ARGS', `unknown subcommand ${JSON.stringify(argv[0])}`);
const FLAGS = ['--vm-id', '--mode', '--data-dir', '--resources', '--sandbox-id', '--repo-key', '--proxy-port', '--cpus', '--memory-mib', '--rosetta'];
const args = {};
for (let i = 1; i < argv.length; i += 2) {
  const flag = argv[i];
  if (!FLAGS.includes(flag) || i + 1 >= argv.length || flag in args) fail('E_ARGS', `bad flag ${JSON.stringify(flag)}`);
  args[flag] = argv[i + 1];
}
const intIn = (value, min, max) => /^[0-9]+$/.test(value ?? '') && Number(value) >= min && Number(value) <= max;
const mode = args['--mode'];
if (mode !== 'job' && mode !== 'refresh') fail('E_ARGS', 'mode must be job or refresh');
const vmId = args['--vm-id'];
if (!ID_RE.test(vmId ?? '') || (vmId.startsWith('0-') !== (mode === 'refresh'))) fail('E_ARGS', 'bad vm id');
for (const flag of ['--data-dir', '--resources']) {
  if (!path.isAbsolute(args[flag] ?? '')) fail('E_ARGS', `${flag} must be absolute`);
}
if (!intIn(args['--cpus'], 1, 64) || !intIn(args['--memory-mib'], 1024, 65536)) fail('E_ARGS', 'bad size');
if (args['--rosetta'] !== 'auto' && args['--rosetta'] !== 'off') fail('E_ARGS', 'bad rosetta');
if (mode === 'job') {
  if (!ID_RE.test(args['--sandbox-id'] ?? '') || !intIn(args['--proxy-port'], 1, 65535)) fail('E_ARGS', 'job flags');
  if ('--repo-key' in args) fail('E_ARGS', 'a job VM takes no repo key');
} else {
  if (!REPO_KEY_RE.test(args['--repo-key'] ?? '')) fail('E_ARGS', 'refresh flags');
  if ('--sandbox-id' in args || '--proxy-port' in args) fail('E_ARGS', 'a refresh VM takes no sandbox or proxy');
}
if (process.ppid === 1) fail('E_ARGS', 'orphaned at start');

const dataDir = fs.realpathSync(args['--data-dir']);
const vmDir = path.join(dataDir, 'vm', 'jobs', vmId);

// --- The share, the guest and the disk ----------------------------------------

let share = null;
if (mode === 'job') {
  try {
    const sandboxBase = fs.realpathSync(path.join(dataDir, 'runner', 'sandbox'));
    const sandbox = fs.realpathSync(path.join(sandboxBase, args['--sandbox-id']));
    share = `${sandbox}/_work`;
    const stat = fs.lstatSync(share);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a directory');
    if (fs.realpathSync(share) !== share) throw new Error('not its real path');
    if (!share.startsWith(`${sandboxBase}/`)) throw new Error('outside runner/sandbox');
    if (stat.dev !== fs.statSync(sandbox).dev) throw new Error('on another device');
    if (fs.statSync(sandbox).dev !== fs.statSync(sandboxBase).dev) throw new Error('its sandbox is on another device');
  } catch (err) {
    fail('E_SHARE', `${share}: ${err.message}`);
  }
}
try {
  const guest = path.join(args['--resources'], 'guest');
  const manifest = JSON.parse(fs.readFileSync(path.join(guest, 'manifest.json'), 'utf8'));
  for (const name of ['vmlinux', 'initramfs.cpio.gz', 'rootfs.erofs']) {
    if (fs.statSync(path.join(guest, name)).size !== manifest.artifacts[name].size) throw new Error(`${name} size`);
  }
} catch (err) {
  fail('E_GUEST_IMAGE', err.message);
}
const disk = mode === 'job' ? path.join(vmDir, 'data.img') : path.join(dataDir, 'vm', 'cache', args['--repo-key'], 'data.img.new');
if (!fs.existsSync(disk)) fail('E_DISK', `${disk} is missing`);

// --- Stopping -----------------------------------------------------------------

let state = 'starting';
let stopping = false;
function stop(reason, extra = {}) {
  if (stopping) return;
  stopping = true;
  state = 'stopping';
  setTimeout(() => {
    emit({ event: 'stopped', reason, ...extra });
    process.exit(reason === 'guest' ? 0 : (helper.stopExitCode ?? 0));
  }, reason === 'requested' ? (helper.stopDelayMs ?? 0) : 0);
}
process.on('SIGTERM', () => {
  log('info', 'SIGTERM');
  if (!helper.ignoreSigterm) stop('requested');
});

// --- The sockets (§2.3) ---------------------------------------------------------

process.chdir(vmDir);
const agentConnections = new Set();
function serveDocker(client) {
  const target = process.env.FAKE_DOCKERD_SOCKET;
  if (!target) {
    client.destroy();
    return;
  }
  const daemon = net.connect(target);
  daemon.on('error', () => client.destroy());
  client.on('error', () => daemon.destroy());
  client.pipe(daemon);
  daemon.pipe(client);
}

let configured = false;
function answerAgent(connection, request) {
  const op = request.op;
  const how = script[op] ?? {};
  const reply = (body) => {
    if (connection.destroyed) return;
    if (how.close) {
      connection.destroy();
      return;
    }
    if (how.raw !== undefined) {
      connection.write(`${how.raw}\n`);
      return;
    }
    if (how.error) {
      connection.write(`${JSON.stringify({ v: 1, id: request.id, ok: false, ...how.error })}\n`);
      return;
    }
    connection.write(`${JSON.stringify({ v: 1, id: request.id, ok: true, ...body, ...(how.answer ?? {}) })}\n`);
  };
  let body;
  switch (op) {
    case 'hello':
      body = { agent: '0.0.0-fake', guestVersion: '2026.10.0', kernel: '6.18.54-0-virt', agentProtocol: 1 };
      break;
    case 'configure': {
      if (configured) {
        connection.write(`${JSON.stringify({ v: 1, id: request.id, ok: false, code: 'E_CONFIGURED', message: 'already configured' })}\n`);
        return;
      }
      configured = true;
      log('info', `configure ${JSON.stringify(request)}`);
      body = {
        docker: { version: '29.5.3', apiVersion: '1.54', minApiVersion: '1.24' },
        disk: 'formatted',
        rosetta: request.rosetta ? 'ok' : 'absent',
        // A refresh VM checks its rules alone and reports the rest as not run (§3.4).
        selftest: mode === 'job'
          ? { rules: true, internalNoRelay: true, internalForgedRejected: true, gatewayRejected: true, bridgeReachesRelay: true, outsideRejected: true }
          : { rules: true, internalNoRelay: false, internalForgedRejected: false, gatewayRejected: false, bridgeReachesRelay: false, outsideRejected: false },
      };
      if (mode === 'job') {
        const fd = fs.openSync(path.join(request.share.mountPath, request.share.nonceFile), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const buffer = Buffer.alloc(64);
        const n = fs.readSync(fd, buffer, 0, 64, 0);
        fs.closeSync(fd);
        body.nonce = buffer.subarray(0, n).toString('utf8');
      }
      break;
    }
    case 'approve-binds':
      log('info', `approve-binds ${request.container} ${JSON.stringify(request.binds)}`);
      body = {};
      break;
    case 'set-time':
      log('info', `set-time ${request.unixMs}`);
      body = {};
      break;
    case 'status':
      body = { dockerd: 'running', uptimeMs: Date.now() - started };
      break;
    case 'shutdown':
      body = {};
      setTimeout(() => stop('guest', mode === 'refresh' ? { synced: true } : {}), 10);
      break;
    default:
      connection.write(`${JSON.stringify({ v: 1, id: request.id, ok: false, code: 'E_UNKNOWN_OP', message: `unknown op ${op}` })}\n`);
      return;
  }
  if (how.delayMs) setTimeout(() => reply(body), how.delayMs);
  else reply(body);
}
function serveAgent(connection) {
  if (Date.now() - started < (helper.agentAfterMs ?? 0)) {
    // Logged, so a test can wait for the client to be trying the agent.
    log('debug', 'agent.sock: the agent is not up yet');
    connection.destroy();
    return;
  }
  agentConnections.add(connection);
  connection.on('close', () => agentConnections.delete(connection));
  connection.on('error', () => {});
  let buffered = '';
  connection.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    for (let nl = buffered.indexOf('\n'); nl !== -1; nl = buffered.indexOf('\n')) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      try {
        answerAgent(connection, JSON.parse(line));
      } catch {
        connection.write(`${JSON.stringify({ v: 1, id: 0, ok: false, code: 'E_PROTO', message: 'bad request' })}\n`);
      }
    }
  });
}

const listen = (name, handler) =>
  new Promise((resolve) => {
    fs.rmSync(name, { force: true });
    const server = net.createServer(handler);
    server.on('error', (err) => fail('E_SOCKET', `${name}: ${err.message}`));
    // Bound by its name in the VM's directory, the process's cwd, so a long
    // <data> cannot overflow a socket path.
    server.listen(name, () => {
      fs.chmodSync(name, 0o600);
      resolve(server);
    });
  });

await listen('docker.sock', serveDocker);
await listen('agent.sock', serveAgent);
emit({ event: 'listening', dockerSocket: path.join(vmDir, 'docker.sock'), agentSocket: path.join(vmDir, 'agent.sock') });

if (helper.exitAfterListening !== undefined) {
  log('error', 'start failed');
  process.exit(helper.exitAfterListening);
}
state = 'running';
emit({
  event: 'started',
  pid: process.pid,
  rosetta: args['--rosetta'] === 'off' ? 'off' : (helper.rosetta ?? 'notInstalled'),
  startMs: Date.now() - started,
});
for (const line of helper.stdout ?? []) process.stdout.write(`${line}\n`);
process.on('SIGUSR2', () => {
  log('info', 'the guest powered off');
  stop('guest');
});

// --- Commands (§2.4) --------------------------------------------------------------

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk.toString('utf8');
  for (let nl = input.indexOf('\n'); nl !== -1; nl = input.indexOf('\n')) {
    const line = input.slice(0, nl);
    input = input.slice(nl + 1);
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      continue;
    }
    if (command.op === 'stop') {
      log('info', `stop graceMs=${command.graceMs}`);
      emit({ id: command.id, ok: true });
      stop('requested');
    } else if (command.op === 'ping') {
      emit({ id: command.id, ok: true, state });
    } else {
      emit({ id: command.id, ok: false, code: 'E_ARGS', message: `unknown command ${command.op}` });
    }
  }
});
// Stdin's end is the parent going away (§2.4 "Parent death").
process.stdin.on('end', () => {
  log('info', 'stdin closed');
  stop('requested');
});
