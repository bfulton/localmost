#!/usr/bin/env node
/**
 * A stand-in for the localmost-macvm helper, for tests of the Electron side
 * (src/main/isolation/macos-vm). Tests run it directly through the client's
 * injected spawn, never through sandbox-exec.
 *
 * It takes the helper's argument line (native/localmost-macvm,
 * MacVMCore/Args.swift), refuses what the real parser refuses with E_ARGS,
 * and plays each command's events, ending with one `end`. Its files are the
 * real layout's: install writes config.json, disk.img and aux.img into the
 * image directory, save-state fills the slot directory, run writes
 * helper.pid and binds agent.sock in the VM directory - each only where the
 * directory already exists, as the real helper creates none.
 *
 * FAKE_MACVM_SCRIPT is JSON, keyed by command, each optional:
 *   { "<command>": { "end": {...} } }        fields merged into the end
 *   { "<command>": { "fail": "E_CODE" } }    end with this code and its exit code
 *   { "<command>": { "lines": ["..."] } }    raw stdout lines before the end
 *   { "<command>": { "hang": true } }        never end on its own
 *   { "<command>": { "exitWithoutEnd": n } } exit with n and no end
 *   { "provision": { "guestStopsAfterMs": n } } the guest powers off n ms after starting
 *   { "save-state": { "failSlot": n } }      that slot's save fails with E_STATE
 *   { "run": { "agentAfterMs": n } }         agent.sock connections are closed until then
 *   { "agent": { ... } }                     the guest agent, below
 * The agent's hello says `ready` and `runnerVersions` (default ["2.330.0"]);
 * "jobOutput" lines are sent as stdout output after a job starts, then exit
 * "jobExitCode" (default 0) unless "jobHold" keeps it running until a signal;
 * "raw" is sent instead of the hello; "refuse": {"<op>": "message"} refuses
 * that op.
 *
 * FAKE_MACVM_RECORD names a file each received line is appended to as JSON:
 * {"argv"}, {"env"}, {"stdin"}, {"agent"}, so a test can see what reached it.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

const script = process.env.FAKE_MACVM_SCRIPT ? JSON.parse(process.env.FAKE_MACVM_SCRIPT) : {};
const EXIT = {
  E_ARGS: 64, E_IMAGE: 65, E_IPSW: 66, E_INSTALL: 67, E_VZ_CONFIG: 68, E_VZ_START: 69, E_SOCKET: 70,
  E_GUEST_ERROR: 71, E_SLOT: 72, E_CLONE: 73, E_STATE: 74, E_UNSUPPORTED: 75, E_CATALOG: 76,
};

const record = (entry) => {
  if (process.env.FAKE_MACVM_RECORD) fs.appendFileSync(process.env.FAKE_MACVM_RECORD, `${JSON.stringify(entry)}\n`);
};
const log = (level, message) => process.stderr.write(`${level} ${message}\n`);
const emit = (body) => process.stdout.write(`${JSON.stringify({ v: 1, ...body })}\n`);

let ended = false;
function end(fields, exitCode = 0) {
  if (ended) return;
  ended = true;
  emit({ event: 'end', ...fields });
  setImmediate(() => process.exit(exitCode));
}
function fail(code, message) {
  log('error', message);
  end({ ok: false, reason: 'error', code, message }, EXIT[code] ?? 1);
}

const argv = process.argv.slice(2);
record({ argv });
// macOS sets __CF_USER_TEXT_ENCODING in every process itself.
record({ env: Object.keys(process.env).filter((k) => !k.startsWith('FAKE_MACVM_') && k !== '__CF_USER_TEXT_ENCODING').sort() });
const command = argv[0];
const FLAGS = {
  catalog: [],
  inspect: ['--ipsw'],
  install: ['--data-dir', '--image-id', '--ipsw', '--disk-gib', '--slot'],
  provision: ['--data-dir', '--image-id', '--slot', '--display'],
  'save-state': ['--data-dir', '--image-id', '--slot', '--cpus', '--memory-mib'],
  run: ['--data-dir', '--image-id', '--vm-id', '--proxy-port', '--broker-port', '--cpus', '--memory-mib', '--boot'],
  check: ['--data-dir', '--image-id'],
};
const own = script[command] ?? {};
const args = {};
if (!(command in FLAGS)) {
  fail('E_ARGS', `unknown command ${JSON.stringify(command)}`);
} else {
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!FLAGS[command].includes(flag) || i + 1 >= argv.length || flag in args) fail('E_ARGS', `bad flag ${JSON.stringify(flag)}`);
    args[flag] = argv[i + 1];
  }
  for (const flag of FLAGS[command]) if (!(flag in args)) fail('E_ARGS', `${command}: ${flag} is required`);
  if (args['--image-id'] !== undefined && !/^[0-9a-f]{12}$/.test(args['--image-id'])) fail('E_ARGS', 'bad image id');
  if (args['--vm-id'] !== undefined && !/^[12]-[0-9a-f]{12}$/.test(args['--vm-id'])) fail('E_ARGS', 'bad vm id');
  if (args['--slot'] !== undefined && !/^[12]$/.test(args['--slot'])) fail('E_ARGS', 'bad slot');
}

const data = args['--data-dir'];
const imageDir = data && args['--image-id'] ? path.join(data, 'macos-vm', 'images', args['--image-id']) : null;

// --- stdin: commands, and EOF as the parent gone -------------------------------

let onStop = () => end({ ok: true, reason: 'requested' });
let buffered = '';
process.stdin.on('data', (chunk) => {
  buffered += chunk.toString('utf8');
  let nl;
  while ((nl = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    record({ stdin: msg });
    if (msg.op === 'ping') emit({ id: msg.id, ok: true, state: 'running' });
    else if (msg.op === 'stop') {
      if (msg.id !== undefined) emit({ id: msg.id, ok: true });
      onStop();
    } else if (msg.op === 'provision' && command === 'provision') provisioned(msg);
  }
});
process.stdin.on('end', () => onStop());
process.on('SIGTERM', () => onStop());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const has = (dir) => dir !== null && fs.existsSync(dir) && fs.lstatSync(dir).isDirectory();

async function play() {
  if (ended) return;
  for (const line of own.lines ?? []) process.stdout.write(`${line}\n`);
  if (own.exitWithoutEnd !== undefined) return process.exit(own.exitWithoutEnd);
  if (own.fail) return fail(own.fail, `${command} failed as scripted`);
  switch (command) {
    case 'catalog':
      return end({
        ok: true, reason: 'done', build: '25G83', os: '26.6.2', supported: true, minCpus: 2, minMemoryBytes: 4294967296,
        url: 'https://updates.cdn-apple.com/2026SummerFCS/fullrestores/140-75212/A2A24B94/UniversalMac_26.6.2_25G83_Restore.ipsw',
        ...own.end,
      });
    case 'inspect':
      if (!fs.existsSync(args['--ipsw'])) return fail('E_IPSW', 'the restore image cannot be read');
      return end({ ok: true, reason: 'done', build: '25G83', os: '26.6.2', supported: true, minCpus: 2, minMemoryBytes: 4294967296, ...own.end });
    case 'install': {
      if (!has(imageDir)) return fail('E_ARGS', `${imageDir} cannot be opened`);
      if (!fs.existsSync(args['--ipsw'])) return fail('E_IPSW', 'missing restore image');
      emit({ event: 'progress', phase: 'load', percent: 0 });
      emit({ event: 'image', build: '25G83', os: '26.6.2', minCpus: 2, minMemoryBytes: 4294967296 });
      fs.writeFileSync(path.join(imageDir, 'disk.img'), '');
      fs.writeFileSync(path.join(imageDir, 'aux.img'), 'aux');
      for (const percent of [0, 25, 50, 75, 100]) {
        if (ended) return;
        emit({ event: 'progress', phase: 'install', percent });
        await sleep(own.stepMs ?? 5);
      }
      if (own.hang) return;
      fs.writeFileSync(path.join(imageDir, 'config.json'), JSON.stringify({ imageId: args['--image-id'], build: '25G83' }));
      return end({ ok: true, reason: 'done', build: '25G83', os: '26.6.2', diskBytes: Number(args['--disk-gib']) * 2 ** 30, ...own.end });
    }
    case 'provision': {
      if (!has(imageDir) || !fs.existsSync(path.join(imageDir, 'config.json'))) return fail('E_IMAGE', 'the image has no config.json');
      if (args['--display'] === 'none') {
        if (own.unsupported) return fail('E_UNSUPPORTED', 'headless provisioning needs macOS 27 or later on this Mac');
        emit({ event: 'ready' });
        return;
      }
      return startGuest();
    }
    case 'save-state': {
      if (!has(imageDir)) return fail('E_IMAGE', 'no image');
      const slot = path.join(imageDir, `slot${args['--slot']}`);
      if (!has(slot)) return fail('E_CLONE', `${slot} cannot be opened`);
      if (own.failSlot === Number(args['--slot'])) return fail('E_STATE', `slot ${args['--slot']} could not be saved`);
      emit({ event: 'started', pid: process.pid, boot: 'cold', startMs: 5 });
      await sleep(own.stepMs ?? 5);
      if (own.hang) return;
      emit({ event: 'agentReady' });
      for (const name of ['disk.img', 'aux.img', 'state.vzvmsave']) fs.writeFileSync(path.join(slot, name), name);
      fs.writeFileSync(path.join(slot, 'state.json'), JSON.stringify({ slot: Number(args['--slot']) }));
      emit({ event: 'saved' });
      return end({ ok: true, reason: 'done' });
    }
    case 'run':
      return run();
    case 'check':
      if (!has(imageDir) || !fs.existsSync(path.join(imageDir, 'config.json'))) return fail('E_IMAGE', 'the image has no config.json: its install never finished');
      return end({
        ok: true, reason: 'done', build: '25G83', os: '26.6.2', supported: true, diskBytes: 64 * 2 ** 30, diskAllocatedBytes: 15 * 2 ** 30,
        states: {
          1: { hostBuild: '25G83', cpus: 4, memoryMiB: 6144, helperVersion: '1.0.0', stateBytes: 2 ** 31 },
          2: { hostBuild: '25G83', cpus: 4, memoryMiB: 6144, helperVersion: '1.0.0', stateBytes: 2 ** 31 },
        },
        ...own.end,
      });
  }
}

function startGuest() {
  emit({ event: 'started', pid: process.pid, boot: 'cold', startMs: 7, mac: '02:11:22:33:44:55' });
  if (own.guestStopsAfterMs !== undefined) setTimeout(() => end({ ok: true, reason: 'guest' }), own.guestStopsAfterMs);
}

let provisionedOnce = false;
function provisioned(msg) {
  if (provisionedOnce) return;
  provisionedOnce = true;
  if (typeof msg.username !== 'string' || typeof msg.password !== 'string' || msg.password.length < 16) {
    return fail('E_ARGS', "the account's password must be 16-128 printable ASCII characters with no spaces");
  }
  startGuest();
}

// --- run: a job VM and its guest agent -------------------------------------------

function run() {
  const vmDir = path.join(data, 'macos-vm', 'vms', args['--vm-id']);
  if (!has(vmDir)) return fail('E_ARGS', `${vmDir} cannot be opened`);
  if (!has(imageDir) || !fs.existsSync(path.join(imageDir, 'config.json'))) return fail('E_IMAGE', 'the image has no config.json');
  fs.writeFileSync(path.join(vmDir, 'helper.pid'), `${process.pid}\n`);
  for (const name of ['disk.img', 'aux.img']) fs.writeFileSync(path.join(vmDir, name), '');
  const socket = path.join(vmDir, 'agent.sock');
  const agent = script.agent ?? {};
  const startedAt = Date.now();
  const server = net.createServer((conn) => {
    if (Date.now() - startedAt < (own.agentAfterMs ?? 0)) return conn.destroy();
    serveAgent(conn, agent);
  });
  server.listen(socket, () => {
    emit({ event: 'listening', agentSocket: socket });
    const restoring = args['--boot'] === 'restore' && !own.noState;
    emit({
      event: 'started', pid: process.pid, boot: restoring ? 'restore' : 'cold', startMs: 9,
      ...(args['--boot'] === 'restore' && own.noState ? { restoreSkipped: 'slot 1 has no saved state' } : {}),
    });
  });
  const close = () => {
    server.close();
    for (const name of ['disk.img', 'aux.img']) fs.rmSync(path.join(vmDir, name), { force: true });
  };
  onStop = () => {
    close();
    end({ ok: true, reason: 'requested' });
  };
  if (own.guestStopsAfterMs !== undefined) setTimeout(() => (close(), end({ ok: true, reason: 'guest' })), own.guestStopsAfterMs);
}

let jobStarted = false;
function serveAgent(conn, agent) {
  const send = (body) => conn.write(`${JSON.stringify({ v: 1, ...body })}\n`);
  if (agent.raw !== undefined) return conn.write(`${agent.raw}\n`);
  send({ event: 'hello', agent: '1.0.0', ready: agent.ready ?? true, os: '26.6.2', runnerVersions: agent.runnerVersions ?? ['2.330.0'] });
  let buf = Buffer.alloc(0);
  let raw = null;
  let job = null;
  conn.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (raw) {
        if (buf.length < raw.bytes) return;
        const bytes = buf.subarray(0, raw.bytes);
        buf = buf.subarray(raw.bytes);
        const sha = crypto.createHash('sha256').update(bytes).digest('hex');
        record({ agent: { upload: raw.version, bytes: bytes.length, sha256ok: sha === raw.sha256 } });
        if (sha === raw.sha256) send({ id: raw.id, ok: true, installed: raw.version });
        else send({ id: raw.id, ok: false, code: 'E_PROTO', message: 'the runner\'s bytes do not match their sha256' });
        raw = null;
        continue;
      }
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      const line = buf.subarray(0, nl).toString('utf8');
      buf = buf.subarray(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      record({ agent: msg });
      const refusal = agent.refuse?.[msg.op];
      if (refusal) {
        send({ id: msg.id, ok: false, code: 'E_PROTO', message: refusal });
        continue;
      }
      switch (msg.op) {
        case 'ping':
          send({ id: msg.id, ok: true, jobStarted });
          break;
        case 'prepare':
          send({ id: msg.id, ok: true });
          break;
        case 'runner':
          raw = { id: msg.id, bytes: msg.bytes, sha256: msg.sha256, version: msg.version };
          send({ id: msg.id, ok: true, send: true });
          break;
        case 'job':
          jobStarted = true;
          send({ id: msg.id, ok: true, pid: 4242 });
          job = { running: true };
          for (const data of agent.jobOutput ?? []) send({ event: 'output', stream: 'stdout', data });
          if (!agent.jobHold) {
            job.running = false;
            send({ event: 'exit', code: agent.jobExitCode ?? 0, signal: null });
          }
          break;
        case 'signal':
          send({ id: msg.id, ok: true });
          if (job?.running) {
            job.running = false;
            send({ event: 'exit', code: null, signal: `SIG${msg.signal}` });
          }
          break;
        default:
          send({ id: msg.id, ok: false, code: 'E_PROTO', message: 'unknown command' });
      }
    }
  });
  conn.on('error', () => {});
}

void play();
