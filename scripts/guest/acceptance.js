'use strict';

// The WP-A acceptance harness (contract §4, the plan's WP-A acceptance).
// It boots the built guest in job mode on the Mac with vzrun, a scratch
// _work share and a scratch data disk, and runs every acceptance check
// against the real dockerd, runc and firewall in the guest. Because there is
// no filter here, the harness plays the filter's part: it sends the agent an
// approve-binds for the share binds of every container it starts, exactly as
// DockerFilterProxy will. It prints one PASS/FAIL line per check and exits
// non-zero if any failed. Every check must pass in one run.
//
//   node scripts/guest/acceptance.js
//
// It needs build/guest (run `npm run build:guest` first), a docker CLI (set
// LM_DOCKER, or it uses build/docker-cli/docker), and Go (for the in-guest
// hook tests and the network probe). Its scratch directory is under the
// checkout's build/ (set LM_WORKDIR to move it; the share must be under
// /Users, /Volumes or /private) and is removed at the end.
//
// It talks to dockerd directly, so it can also run the privileged, host-
// namespace containers it uses to look at the guest itself (its firewall,
// dmesg, dockerd's log) and to kill lm-agent. A job's containers can do
// none of this: the filter refuses privileged and host namespaces.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { runVm } = require('./vm');
const { connectAgent, sleep } = require('./guestio');
const { buildImage } = require('./fixture-image');
const { readApk } = require('./apk');
const { newc, gzipFixed } = require('./cpio');
const { moduleClosure } = require('./compose');

const ROOT = path.resolve(__dirname, '..', '..');
const GUEST = path.join(ROOT, 'build', 'guest');
const CACHE = path.join(ROOT, 'build', 'guest-cache');
const APKS = path.join(CACHE, 'apks');
const DOCKER = process.env.LM_DOCKER || path.join(ROOT, 'build', 'docker-cli', 'docker');
const GO_ENV = {
  ...process.env,
  GOOS: 'linux',
  GOARCH: 'arm64',
  CGO_ENABLED: '0',
  GOCACHE: path.join(CACHE, 'go', 'build'),
  GOMODCACHE: path.join(CACHE, 'go', 'mod'),
};

/**
 * Module requests the guest refuses on purpose (contract §5.2). dockerd asks
 * for these; any other refused request in dmesg is a missing allowlist entry.
 */
const REFUSED_BY_DESIGN = {
  net_pf_10: 'IPv6 is off (ipv6.disable=1)',
  af_packet: 'raw packet sockets, reachable with Docker’s default CAP_NET_RAW; only unsolicited ARP uses them',
  xfrm_user: 'IPsec for encrypted overlay networks, which a single-host guest has none of',
};

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  return !!ok;
}
async function step(name, fn) {
  try {
    return check(name, true, (await fn()) || '');
  } catch (err) {
    return check(name, false, err.message);
  }
}

function sparse(p, bytes) {
  fs.rmSync(p, { force: true });
  const fd = fs.openSync(p, 'wx', 0o600);
  fs.ftruncateSync(fd, bytes);
  fs.closeSync(fd);
}

// Removes a path that may be a link to a guest or Mac root: the link itself,
// never what it points to.
function removeLinkOrTree(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) fs.unlinkSync(p);
  else fs.rmSync(p, { recursive: true, force: true });
}

// lm-bindpin's refusal as it reaches the client: runc's createRuntime hook
// failed with stderr starting "localmost: bind <source>". dockerd cuts the
// hook's stderr short, so the rest of the message ("was not approved", "is
// not a mount of the share") may be missing; the guest tests pin the text.
const BINDPIN = /createRuntime hook #0: exit status 1, stdout: [^,]*, stderr: localmost: bind \//;

const oneLine = (s, n = 300) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);

// A host HTTP forward proxy on a unix socket, the far end of the relay: it
// allows GETs whose host is in `allow` (200 "reached <host>") when the
// injected token is right, refuses the rest 403, and records what it saw.
// A connection that starts "HOLD\n" is answered "early\n" at once and
// "late\n" three seconds later, before it is closed: the check that bytes
// reach the container while the connection stays open.
function fakeProxy(sockPath, allow, token) {
  const seen = [];
  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      if (buf === null) return;
      buf += d.toString('latin1');
      if (buf.startsWith('HOLD\n')) {
        buf = null;
        c.write('early\n');
        setTimeout(() => c.end('late\n'), 3000);
        return;
      }
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const [reqLine, ...headers] = buf.slice(0, end).split('\r\n');
      buf = null;
      const m = /^(\w+)\s+(\S+)/.exec(reqLine) || [];
      const auth = headers.find((l) => /^proxy-authorization:/i.test(l)) || '';
      let host = '';
      try {
        host = new URL(m[2]).host.split(':')[0];
      } catch {
        host = '';
      }
      seen.push({ host, auth });
      const okToken = auth.includes(Buffer.from(`localmost:${token}`).toString('base64'));
      if (okToken && allow.includes(host)) {
        const body = `reached ${host}`;
        c.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      } else {
        c.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      }
    });
    c.on('error', () => {});
  });
  fs.rmSync(sockPath, { force: true });
  server.listen(sockPath);
  return { seen, close: () => server.close() };
}

/**
 * The docker CLI against one VM's socket, run asynchronously so that the
 * fake proxy in this process can answer while a container waits on it. Its
 * config directory is an empty scratch one: never the user's ~/.docker and
 * its credential helpers.
 */
function dockerCli(sock, configDir) {
  const run = (args, opts = {}) =>
    new Promise((resolve, reject) => {
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: configDir, DOCKER_HOST: `unix://${sock}`, ...(opts.env || {}) };
      const child = spawn(DOCKER, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeout || 90000);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`docker ${args[0]}: ${err.message}`));
      });
      child.on('close', (status, signal) => {
        clearTimeout(timer);
        const r = { stdout: stdout.trim(), stderr: stderr.trim(), status: status ?? signal };
        if (status !== 0 && !opts.allowFail) {
          const msg = (r.stderr || r.stdout)
            .split('\n')
            .filter((l) => l.trim() && !/^Run 'docker .* --help'/.test(l))
            .slice(-2)
            .join(' ');
          reject(new Error(`docker ${args.slice(0, 6).join(' ')}: ${signal ? `killed (${signal}) ` : ''}${oneLine(msg)}`));
        } else {
          resolve(r);
        }
      });
    });
  return run;
}

/**
 * Runs `cmd` with the guest's own root and namespaces, from a privileged
 * host-namespace container. The guest root's busybox has no applet links
 * but sh, so commands name `busybox <applet>` or a full path.
 */
function inGuest(d, cmd, opts = {}) {
  return d(['run', '--rm', '--privileged', '--pid', 'host', '--network', 'host', 'bb:arm', 'chroot', '/proc/1/root', '/bin/sh', '-c', cmd], opts);
}

// Creates a container, sends the agent the approve-binds for its share
// binds (as the filter would), and returns its id. `binds` is
// [{ host, dest, ro }]; `mount` uses --mount instead of -v.
async function createApproved(d, conn, image, cmd, binds, { mount = false, extraArgs = [] } = {}) {
  const bargs = binds.flatMap((b) =>
    mount ? ['--mount', `type=bind,src=${b.host},dst=${b.dest}${b.ro ? ',readonly' : ''}`] : ['-v', `${b.host}:${b.dest}${b.ro ? ':ro' : ''}`],
  );
  const id = (await d(['create', ...extraArgs, ...bargs, image, ...cmd])).stdout;
  const approved = binds.map((b) => ({ source: b.host, destination: b.dest, readOnly: !!b.ro }));
  const ans = await conn.request('approve-binds', { container: id, binds: approved }, 10000);
  if (!ans.ok) throw new Error(`approve-binds: ${ans.code} ${ans.message}`);
  return id;
}

// Reads a static busybox from a cached apk.
function busybox(arch) {
  const file = arch === 'amd64' ? 'x86_64/busybox-static-1.37.0-r31.apk' : 'aarch64/busybox-static-1.37.0-r31.apk';
  return readApk(fs.readFileSync(path.join(APKS, file))).entries.find((e) => e.name === 'bin/busybox.static').data;
}

/** Builds guest/acceptance/netprobe for the guest; returns its bytes. */
function netprobe() {
  const out = path.join(CACHE, 'netprobe');
  execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', out, './acceptance/netprobe'], { cwd: path.join(ROOT, 'guest'), env: GO_ENV, stdio: 'inherit' });
  return fs.readFileSync(out);
}

// Builds an initramfs that mounts the virtiofs share at `sharePath`
// (nosuid, nodev, nosymfollow) and runs the compiled guest hook test
// binary against it, in the guest's own init namespaces (not a container),
// which is where lm-bindpin runs. The binary prints Go test output; its exit
// status is echoed as HOOKTEST-OK or HOOKTEST-FAIL on the console.
function hookTestInitramfs(sharePath, out) {
  const testBin = path.join(CACHE, 'hooktest');
  execFileSync('go', ['test', '-c', '-tags', 'guestvm', '-trimpath', '-ldflags=-s -w', '-o', testBin, './internal/bindpin'], {
    cwd: path.join(ROOT, 'guest'),
    env: GO_ENV,
    stdio: 'inherit',
  });
  const kernel = readApk(fs.readFileSync(path.join(APKS, 'aarch64', 'linux-virt-6.18.54-r0.apk'))).entries;
  const kver = '6.18.54-0-virt';
  const modFile = (rel) => {
    const e = kernel.find((x) => x.name === `lib/modules/${kver}/${rel}`);
    if (!e) throw new Error(`no module ${rel}`);
    return require('zlib').gunzipSync(e.data);
  };
  const dep = kernel.find((e) => e.name === `lib/modules/${kver}/modules.dep`).data.toString();
  const order = moduleClosure(dep, ['virtiofs']);
  const init = `#!/bin/busybox sh
/bin/busybox mount -t devtmpfs devtmpfs /dev
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sysfs /sys
/bin/busybox mount -t tmpfs tmpfs /tmp
exec >/dev/hvc0 2>&1
${order.map((m) => `/bin/busybox insmod /lib/${path.posix.basename(m).replace('.gz', '')}`).join('\n')}
/bin/busybox mkdir -p ${sharePath}
/bin/busybox mount -t virtiofs -o nosuid,nodev,nosymfollow work ${sharePath}
LM_SHARE=${sharePath} /lmtest -test.v
echo "HOOKTEST-$([ $? -eq 0 ] && echo OK || echo FAIL)"
/bin/busybox sync
/bin/busybox poweroff -f
`;
  const entries = [
    ...['bin', 'dev', 'proc', 'sys', 'tmp', 'lib', 'run'].map((n) => ({ name: n, mode: 0o040755 })),
    { name: 'bin/busybox', mode: 0o100755, data: busybox('arm64') },
    { name: 'lmtest', mode: 0o100755, data: fs.readFileSync(testBin) },
    { name: 'init', mode: 0o100755, data: Buffer.from(init) },
    ...order.map((m) => ({ name: `lib/${path.posix.basename(m).replace('.gz', '')}`, mode: 0o100644, data: modFile(m) })),
  ];
  fs.writeFileSync(out, gzipFixed(newc(entries)));
  return out;
}

/** Boots a job VM and configures it; returns what the checks need. */
async function bootJob({ vms, sockDir, name, sharePath, rosetta, proxySock, console: consolePath }) {
  const agentSock = path.join(sockDir, `${name}-agent.sock`);
  const dockerSock = path.join(sockDir, `${name}-docker.sock`);
  const disk = path.join(sockDir, `${name}-data.img`);
  sparse(disk, 12 * 1024 ** 3);
  const t0 = Date.now();
  const vm = runVm({
    kernel: path.join(GUEST, 'vmlinux'),
    initrd: path.join(GUEST, 'initramfs.cpio.gz'),
    cmdline: 'console=hvc0 rdinit=/init ro quiet panic=-1 ipv6.disable=1 lm.mode=job',
    cpus: 4,
    memoryMiB: 4096,
    console: consolePath,
    timeoutSec: 900,
    rosetta,
    shares: [{ tag: 'work', path: sharePath, ro: false }],
    disks: [
      { path: path.join(GUEST, 'rootfs.erofs'), ro: true, sync: 'full' },
      { path: disk, ro: false, sync: 'none' },
    ],
    vsock: [
      { port: 1025, path: agentSock },
      { port: 2375, path: dockerSock },
      { port: 3128, path: proxySock, dir: 'from-guest' },
    ],
  });
  vms.push(vm);
  await vm.started;
  const { conn } = await connectAgent(agentSock);
  const cfg = await conn.request('configure', {
    vmId: '5-0123456789ab',
    mode: 'job',
    timeUnixMs: Date.now(),
    share: { tag: 'work', mountPath: sharePath, nonceFile: '.localmost-share' },
    rosetta,
    relay: { address: '198.18.0.1', port: 3128, vsockPort: 3128 },
  });
  return { vm, conn, cfg, configureMs: Date.now() - t0, dockerSock };
}

async function main() {
  if (!fs.existsSync(path.join(GUEST, 'manifest.json'))) throw new Error('no build/guest; run npm run build:guest first');
  if (!fs.existsSync(DOCKER)) throw new Error(`no docker CLI at ${DOCKER}; set LM_DOCKER`);
  const manifest = JSON.parse(fs.readFileSync(path.join(GUEST, 'manifest.json'), 'utf8'));

  const workBase = process.env.LM_WORKDIR || path.join(ROOT, 'build', 'guest-accept');
  fs.mkdirSync(workBase, { recursive: true });
  const work = fs.mkdtempSync(path.join(workBase, 'work-'));
  // Unix socket paths are short; the socket directory is under the tmpdir.
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-accept-'));
  const vms = [];
  let proxy;
  try {
    const sharePath = path.join(fs.realpathSync(work), '_work');
    fs.mkdirSync(sharePath, { recursive: true });
    const nonce = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(sharePath, '.localmost-share'), nonce, { flag: 'wx' });
    fs.mkdirSync(path.join(sharePath, 'ws'));
    fs.writeFileSync(path.join(sharePath, 'ws', 'f'), 'workspace file\n');
    fs.writeFileSync(path.join(sharePath, 'ws', 'busybox'), busybox('arm64'), { mode: 0o755 });
    const configDir = path.join(work, 'docker-config');
    fs.mkdirSync(configDir);

    const hookInitramfs = hookTestInitramfs(sharePath, path.join(work, 'hooktest-initramfs.cpio.gz'));
    const probe = netprobe();
    const imgDir = path.join(work, 'images');
    const arm = buildImage({
      busyboxApk: path.join(APKS, 'aarch64', 'busybox-static-1.37.0-r31.apk'),
      dest: path.join(imgDir, 'bb-arm.tar'),
      arch: 'arm64',
      name: 'bb:arm',
      extra: [{ name: 'bin/netprobe', type: 'file', mode: 0o755, data: probe }],
    });
    const amd = buildImage({ busyboxApk: path.join(APKS, 'x86_64', 'busybox-static-1.37.0-r31.apk'), dest: path.join(imgDir, 'bb-amd.tar'), arch: 'amd64', name: 'bb:amd' });

    const proxySock = path.join(sockDir, 'proxy.sock');
    const token = 'tok-' + crypto.randomBytes(6).toString('hex');
    proxy = fakeProxy(proxySock, ['allowed.example'], token);
    // The filter injects both cases of each proxy variable; busybox wget reads
    // the lowercase http_proxy.
    const proxyURL = `http://localmost:${token}@198.18.0.1:3128`;
    const proxyArgs = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'].flatMap((k) => ['-e', `${k}=${proxyURL}`]);
    const wantAuth = 'Basic ' + Buffer.from(`localmost:${token}`).toString('base64');

    // ---- the main VM: job mode with Rosetta ------------------------------------
    const mainConsole = path.join(work, 'main-console.log');
    const job = await bootJob({ vms, sockDir, name: 'main', sharePath, rosetta: true, proxySock, console: mainConsole });
    const { vm, conn, cfg } = job;
    if (!cfg.ok) throw new Error(`configure: ${cfg.code} ${cfg.message}`);
    const d = dockerCli(job.dockerSock, configDir);

    check('boot to configure within 3 s', job.configureMs <= 3000, `${job.configureMs} ms`);
    check('configure returned the share nonce', cfg.nonce === nonce, cfg.nonce);
    check('selftest all true, including internalForgedRejected', cfg.selftest && Object.values(cfg.selftest).every(Boolean), JSON.stringify(cfg.selftest));
    check('rosetta ok (installed on this Mac)', cfg.rosetta === 'ok', cfg.rosetta);

    await step('docker load of a fixture image; ids are the config digests', async () => {
      await d(['load', '-i', path.join(imgDir, 'bb-arm.tar')]);
      await d(['load', '-i', path.join(imgDir, 'bb-amd.tar')]);
      const ids = (await d(['images', '-q', '--no-trunc'])).stdout;
      if (!ids.includes(arm.configDigest) || !ids.includes(amd.configDigest)) throw new Error(`ids do not match: ${oneLine(ids)}`);
    });

    await step('docker run returns the container’s output (attach through the vsock splice)', async () => {
      for (let i = 0; i < 3; i++) {
        const out = (await d(['run', '--rm', 'bb:arm', 'echo', `hello-${i}`])).stdout;
        if (out !== `hello-${i}`) throw new Error(`run ${i + 1}: stdout ${JSON.stringify(out)}`);
      }
      const piped = await new Promise((resolve, reject) => {
        const env = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: configDir, DOCKER_HOST: `unix://${job.dockerSock}` };
        const child = spawn(DOCKER, ['run', '--rm', '-i', 'bb:arm', 'cat'], { env });
        let out = '';
        child.stdout.on('data', (b) => (out += b));
        child.on('error', reject);
        child.on('close', () => resolve(out.trim()));
        child.stdin.end('from stdin\n');
      });
      if (piped !== 'from stdin') throw new Error(`stdin round trip: ${JSON.stringify(piped)}`);
      return '3 runs and a stdin round trip';
    });

    const readLockdown = async () => (await d(['run', '--rm', 'bb:arm', 'cat', '/proc/sys/kernel/modules_disabled', '/proc/sys/kernel/kexec_load_disabled'])).stdout.split(/\s+/).join(',');
    await step('kernel.modules_disabled and kexec_load_disabled read 1 after configure', async () => {
      const v = await readLockdown();
      if (v !== '1,1') throw new Error(`modules_disabled,kexec_load_disabled = ${v}`);
    });

    // ---- the share -------------------------------------------------------------
    await step('run -v <share>/ws:/w:ro reads the workspace file', async () => {
      const id = await createApproved(d, conn, 'bb:arm', ['cat', '/w/f'], [{ host: `${sharePath}/ws`, dest: '/w', ro: true }]);
      const out = (await d(['start', '-a', id])).stdout;
      await d(['rm', '-f', id], { allowFail: true });
      if (out !== 'workspace file') throw new Error(JSON.stringify(out));
    });

    await step('an inner symlink in an approved bind resolves', async () => {
      fs.rmSync(path.join(sharePath, 'ws', 'flink'), { force: true });
      fs.symlinkSync('f', path.join(sharePath, 'ws', 'flink'));
      const id = await createApproved(d, conn, 'bb:arm', ['cat', '/w/flink'], [{ host: `${sharePath}/ws`, dest: '/w', ro: false }]);
      const out = (await d(['start', '-a', id])).stdout;
      await d(['rm', '-f', id], { allowFail: true });
      if (out !== 'workspace file') throw new Error(JSON.stringify(out));
    });

    for (const ro of [false, true]) {
      await step(`exec of a share binary through a${ro ? ' :ro' : 'n rw'} bind works, with nosuid kept and nosymfollow cleared (R11)`, async () => {
        const id = await createApproved(d, conn, 'bb:arm', ['/w/busybox', 'sh', '-c', 'grep " /w " /proc/self/mountinfo; /w/busybox echo exec-ok'], [{ host: `${sharePath}/ws`, dest: '/w', ro }]);
        const out = (await d(['start', '-a', id])).stdout;
        await d(['rm', '-f', id], { allowFail: true });
        const line = out.split('\n').find((l) => / \/w /.test(l)) || '';
        const opts = (line.split(' ')[5] || '').split(',');
        if (!out.includes('exec-ok')) throw new Error(`exec failed: ${oneLine(out)}`);
        if (!opts.includes('nosuid')) throw new Error(`nosuid not kept: ${line}`);
        if (opts.includes('nosymfollow')) throw new Error(`nosymfollow not cleared: ${line}`);
        if (opts.includes('ro') !== ro) throw new Error(`read-only is ${opts.includes('ro')}: ${line}`);
        return opts.join(',');
      });
    }

    // ---- G-A -------------------------------------------------------------------
    // An approved bind whose source becomes a link to a guest path must never
    // show that path in the container. The container prints what it sees at
    // /d; a leak shows the target's own entries. Each case reports the layer
    // that stopped it: lm-bindpin, nosymfollow on the share (ELOOP, or the
    // EEXIST of dockerd's mkdir after its stat hit ELOOP), or, when the
    // container started, a stale mount of the deleted directory that Apple's
    // virtiofs server resolves to nothing (design S1(e)).
    const LEAK = {
      '/': /\b(bin|etc|usr|sbin)\b/,
      '/run': /\b(docker\.sock|docker\.pid|localmost|netns)\b/,
      '/var/lib/docker': /\b(overlay2|containers|image|volumes|\.containerd)\b/,
    };
    const SHOW = 'echo "ls:[$(ls -A /d 2>&1 | tr "\\n" " ")]"; echo "mi:[$(grep " /d " /proc/self/mountinfo)]"; echo "cat:[$(cat /d/marker 2>&1)]"';
    const startedAt = async (id) => (await d(['inspect', '-f', '{{.State.StartedAt}}', id])).stdout;
    let gaN = 0;
    async function gaCase(variant, target) {
      const n = ++gaN;
      const dir = path.join(sharePath, `ga${n}`);
      const parent = path.join(sharePath, `gp${n}`);
      let src = dir;
      let binds;
      let cmd = ['sh', '-c', SHOW];
      if (variant === 'planted') {
        // The container itself replaces its bind's source with a link, through
        // an rw bind of the source's parent, and is restarted.
        src = path.join(parent, 'ga');
        fs.mkdirSync(src, { recursive: true });
        binds = [
          { host: parent, dest: '/p' },
          { host: src, dest: '/d' },
        ];
        cmd = ['sh', '-c', `if [ -L /p/ga ]; then ${SHOW}; else rm -rf /p/ga && ln -s ${target} /p/ga && echo planted; fi`];
      } else {
        fs.mkdirSync(dir);
        binds = [{ host: dir, dest: '/d' }];
      }
      fs.writeFileSync(path.join(src, 'marker'), 'in-share');
      const id = await createApproved(d, conn, 'bb:arm', cmd, binds, { mount: variant === 'mount' });
      try {
        if (variant === 'restart' || variant === 'planted') {
          const first = await d(['start', '-a', id]);
          const want = variant === 'planted' ? 'planted' : 'cat:[in-share]';
          if (!first.stdout.includes(want)) throw new Error(`the first start did not work: ${oneLine(first.stdout + first.stderr)}`);
        }
        if (variant !== 'planted') {
          removeLinkOrTree(dir);
          fs.symlinkSync(target, dir);
        }
        const before = await startedAt(id);
        const r = await d(['start', '-a', id], { allowFail: true });
        const after = await startedAt(id);
        const seen = r.stdout + '\n' + r.stderr;
        const ls = (/ls:\[(.*?)\]/.exec(r.stdout) || [])[1] ?? '';
        if (LEAK[target].test(ls)) throw new Error(`${target} leaked into the container: ${oneLine(seen)}`);
        if (after === before) {
          if (r.status === 0) throw new Error(`start succeeded but the container did not run: ${oneLine(seen)}`);
          if (BINDPIN.test(r.stderr)) return 'refused before start by lm-bindpin';
          if (/too many levels of symbolic links/i.test(r.stderr)) return 'refused before start: ELOOP (nosymfollow on the share)';
          if (/error while creating mount source path .*: file exists/i.test(r.stderr)) return "refused before start: dockerd's mkdir EEXIST after its stat hit ELOOP (nosymfollow)";
          throw new Error(`refused for an unexpected reason: ${oneLine(r.stderr)}`);
        }
        // It started: the mount must be the stale, deleted directory, empty
        // and unreadable, never the link's target.
        if (ls.trim() !== '' || /in-share/.test(r.stdout)) throw new Error(`started and saw content at /d: ${oneLine(r.stdout)}`);
        const cat = (/cat:\[(.*?)\]/.exec(r.stdout) || [])[1] ?? '';
        if (!/Symbolic link loop|No such file/.test(cat)) throw new Error(`started, and reading /d/marker gave: ${cat}`);
        const mi = (/mi:\[(.*?)\]/.exec(r.stdout) || [])[1] ?? '';
        return `started on a stale mount (${oneLine(mi.split(' - ')[0].split(' ').slice(3, 5).join(' '), 80)}), empty, marker: ${cat.replace(/^cat: /, '')} — held by the Mac's virtiofs server`;
      } finally {
        await d(['rm', '-f', id], { allowFail: true });
        removeLinkOrTree(dir);
        removeLinkOrTree(parent);
      }
    }
    for (const [variant, label] of [
      ['v', 'create (-v), swap the source, start'],
      ['mount', 'create (--mount), swap the source, start'],
      ['restart', 'start, swap the source, restart'],
      ['planted', 'a container plants the link through an rw bind, restart'],
    ]) {
      for (const target of ['/', '/run', '/var/lib/docker']) {
        await step(`G-A: ${label}; link to ${target}`, () => gaCase(variant, target));
      }
    }

    await step('a bind that was never approved fails to start with the lm-bindpin message', async () => {
      // No approve-binds is sent, as if the filter never approved it.
      const r = await d(['run', '--rm', '-v', `${sharePath}/ws:/w`, 'bb:arm', 'cat', '/w/f'], { allowFail: true });
      if (r.status === 0) throw new Error('an unapproved bind ran');
      if (!BINDPIN.test(r.stderr)) throw new Error(oneLine(r.stderr));
    });

    await step('a read-only approval does not cover a read-write bind', async () => {
      const id = (await d(['create', '-v', `${sharePath}/ws:/w`, 'bb:arm', 'cat', '/w/f'])).stdout;
      const ans = await conn.request('approve-binds', { container: id, binds: [{ source: `${sharePath}/ws`, destination: '/w', readOnly: true }] }, 10000);
      if (!ans.ok) throw new Error(`approve-binds: ${ans.code}`);
      const r = await d(['start', '-a', id], { allowFail: true });
      await d(['rm', '-f', id], { allowFail: true });
      if (r.status === 0 || !BINDPIN.test(r.stderr)) throw new Error(`started or failed otherwise: ${oneLine(r.stdout + r.stderr)}`);
    });

    // ---- the network -----------------------------------------------------------
    await step('default bridge: a request through the relay reaches the proxy with the injected token and the response comes back', async () => {
      const before = proxy.seen.length;
      const r = await d(['run', '--rm', ...proxyArgs, 'bb:arm', 'wget', '-qO-', '-T', '10', 'http://allowed.example/'], { allowFail: true });
      const got = proxy.seen.slice(before).find((s) => s.host === 'allowed.example');
      if (!got) throw new Error(`the request did not reach the proxy: ${oneLine(r.stderr)}`);
      if (!got.auth.includes(wantAuth)) throw new Error(`the proxy token was not injected: ${got.auth}`);
      if (r.stdout !== 'reached allowed.example') throw new Error(`the container got ${JSON.stringify(r.stdout)}: ${oneLine(r.stderr)}`);
    });

    await step('the relay delivers bytes while its connection stays open', async () => {
      const out = (await d(['run', '--rm', 'bb:arm', 'sh', '-c', '(echo HOLD; sleep 6) | nc 198.18.0.1 3128 > /tmp/o & sleep 1.5; echo "open:[$(cat /tmp/o | tr "\\n" " ")]"; wait; echo "closed:[$(cat /tmp/o | tr "\\n" " ")]"'])).stdout;
      if (!/open:\[early \]/.test(out) || !/closed:\[early late \]/.test(out)) throw new Error(oneLine(out));
    });

    await d(['network', 'create', '--internal', 'lmint']);
    const internalGw = (await d(['network', 'inspect', '-f', '{{(index .IPAM.Config 0).Gateway}}', 'lmint'])).stdout;
    await step('internal network: the relay is unreachable by route', async () => {
      const before = proxy.seen.length;
      const r = await d(['run', '--rm', '--network', 'lmint', ...proxyArgs, 'bb:arm', 'wget', '-qO-', '-T', '5', 'http://internal.example/'], { allowFail: true });
      if (r.status === 0) throw new Error(`the internal container got an answer: ${r.stdout}`);
      if (!/Network unreachable|can't connect/i.test(r.stderr)) throw new Error(`failed otherwise: ${oneLine(r.stderr)}`);
      if (proxy.seen.slice(before).some((s) => s.host === 'internal.example')) throw new Error('an internal container reached the proxy');
      return oneLine(r.stderr, 100);
    });

    await step('internal network: a connect bound to eth0 (no route needed) is reset, and a raw SYN gets a RST, never a SYN-ACK', async () => {
      const before = proxy.seen.length;
      const out = (await d(['run', '--rm', '--network', 'lmint', 'bb:arm', 'sh', '-c', 'netprobe connect -dev eth0 198.18.0.1 3128; netprobe rawsyn -dev eth0 198.18.0.1 3128'])).stdout;
      const [connectRes, synRes] = out.split('\n');
      if (connectRes !== 'ECONNREFUSED') throw new Error(`connect: ${connectRes}`);
      if (synRes !== 'rst') throw new Error(`raw SYN: ${synRes}`);
      if (proxy.seen.length !== before) throw new Error('the proxy saw a connection');
      // The same probe from the default bridge does connect: the probe works.
      const ok = (await d(['run', '--rm', 'bb:arm', 'netprobe', 'connect', '-dev', 'eth0', '198.18.0.1', '3128'])).stdout;
      if (ok !== 'connected') throw new Error(`from the default bridge the probe got ${ok}`);
      return `connect ${connectRes}, raw SYN ${synRes}; default bridge ${ok}`;
    });

    await step('a 0.0.0.0 listener in the guest is refused from the gateway of an internal and a routable network', async () => {
      const lid = (await d(['run', '-d', '--network', 'host', 'bb:arm', 'netprobe', 'listen', '9999'])).stdout;
      try {
        for (let i = 0; i < 50 && !(await d(['logs', lid])).stdout.includes('listening'); i++) await sleep(100);
        const fromInternal = (await d(['run', '--rm', '--network', 'lmint', 'bb:arm', 'netprobe', 'connect', internalGw, '9999'])).stdout;
        const fromBridge = (await d(['run', '--rm', 'bb:arm', 'netprobe', 'connect', '172.17.0.1', '9999'])).stdout;
        const fromGuest = (await d(['run', '--rm', '--network', 'host', 'bb:arm', 'netprobe', 'connect', '127.0.0.1', '9999'])).stdout;
        const accepted = (await d(['logs', lid])).stdout.split('\n').filter((l) => l.startsWith('accepted'));
        if (fromInternal !== 'ECONNREFUSED') throw new Error(`internal gateway ${internalGw}: ${fromInternal}`);
        if (fromBridge !== 'ECONNREFUSED') throw new Error(`default bridge gateway: ${fromBridge}`);
        if (fromGuest !== 'connected') throw new Error(`the listener itself is not up: ${fromGuest}`);
        if (accepted.length !== 1 || !accepted[0].includes('127.0.0.1')) throw new Error(`the listener accepted ${accepted.join('; ')}`);
        return `internal ${fromInternal}, bridge ${fromBridge}, guest loopback ${fromGuest}`;
      } finally {
        await d(['rm', '-f', lid], { allowFail: true });
      }
    });

    await step('a new routable network reaches the relay once its create event is handled, and its rule goes with it', async () => {
      const relayRules = async () => (await inGuest(d, '/usr/sbin/iptables -S LOCALMOST-RELAY')).stdout;
      const nid = (await d(['network', 'create', 'lmroute'])).stdout;
      const iface = `br-${nid.slice(0, 12)}`;
      const want = `-A LOCALMOST-RELAY -i ${iface} -j ACCEPT`;
      let rules = '';
      for (let i = 0; i < 50 && !(rules = await relayRules()).includes(want); i++) await sleep(100);
      if (!rules.includes(want)) throw new Error(`no relay rule for ${iface}: ${oneLine(rules)}`);
      const out = (await d(['run', '--rm', '--network', 'lmroute', ...proxyArgs, 'bb:arm', 'wget', '-qO-', '-T', '10', 'http://allowed.example/'], { allowFail: true })).stdout;
      if (out !== 'reached allowed.example') throw new Error(`a container on it got ${JSON.stringify(out)}`);
      await d(['network', 'rm', 'lmroute']);
      for (let i = 0; i < 50 && (rules = await relayRules()).includes(iface); i++) await sleep(100);
      if (rules.includes(iface)) throw new Error(`the rule outlived the network: ${oneLine(rules)}`);
      const internalIface = `br-${(await d(['network', 'inspect', '-f', '{{.Id}}', 'lmint'])).stdout.slice(0, 12)}`;
      if (rules.includes(internalIface)) throw new Error('the internal network has a relay rule');
      return oneLine(rules);
    });

    await step('AF_VSOCK from a container is refused (the relay’s host port is not reachable around the firewall)', async () => {
      const bridge = (await d(['run', '--rm', 'bb:arm', 'netprobe', 'vsock', '2', '3128'])).stdout;
      const internal = (await d(['run', '--rm', '--network', 'lmint', 'bb:arm', 'netprobe', 'vsock', '2', '3128'])).stdout;
      if (bridge !== 'EPERM' || internal !== 'EPERM') throw new Error(`default bridge ${bridge}, internal ${internal}`);
      return `default bridge ${bridge}, internal ${internal}`;
    });

    await step('DNS for an external name fails in under 100 ms (timed in the container)', async () => {
      const r = await d(['run', '--rm', 'bb:arm', 'sh', '-c', 'time nslookup example.com'], { allowFail: true });
      const real = /real\s+(\d+)m\s*([\d.]+)s/.exec(r.stderr);
      if (!real) throw new Error(`no timing: ${oneLine(r.stdout + r.stderr)}`);
      const ms = Math.round((Number(real[1]) * 60 + Number(real[2])) * 1000);
      if (/^Address:?\s+\d+\.\d+\.\d+\.\d+$/m.test(r.stdout.split('\n').slice(2).join('\n'))) throw new Error(`it resolved: ${oneLine(r.stdout)}`);
      if (!/can't resolve|connection refused|NXDOMAIN|no servers/i.test(r.stdout + r.stderr)) throw new Error(`failed otherwise: ${oneLine(r.stdout + r.stderr)}`);
      if (ms >= 100) throw new Error(`took ${ms} ms`);
      return `${ms} ms: ${oneLine(r.stdout.split('\n').slice(-1)[0], 80)}`;
    });

    await step('embedded DNS on a user-defined network resolves by name, and dockerd logs no Resolver Start failed', async () => {
      await d(['network', 'create', 'lmnet']);
      await d(['run', '-d', '--network', 'lmnet', '--name', 'db', 'bb:arm', 'sleep', '60']);
      try {
        const ip = (await d(['inspect', '-f', '{{.NetworkSettings.Networks.lmnet.IPAddress}}', 'db'])).stdout;
        const r = await d(['run', '--rm', '--network', 'lmnet', 'bb:arm', 'nslookup', 'db'], { allowFail: true });
        if (r.status !== 0 || !new RegExp(`Address:?\\s+${ip.replace(/\./g, '\\.')}`).test(r.stdout)) throw new Error(`nslookup db: ${oneLine(r.stdout + r.stderr)}`);
        const log = (await inGuest(d, 'busybox cat /var/log/dockerd.log')).stdout;
        const bad = log.split('\n').filter((l) => /Resolver Start failed|Failed to delete conntrack/.test(l));
        if (bad.length) throw new Error(`dockerd: ${oneLine(bad[0])}`);
        return `db is ${ip}`;
      } finally {
        await d(['rm', '-f', 'db'], { allowFail: true });
      }
    });

    await step('DOCKER_BUILDKIT=0 build of a two-stage Dockerfile', async () => {
      const ctx = path.join(work, 'buildctx');
      fs.mkdirSync(ctx, { recursive: true });
      fs.writeFileSync(path.join(ctx, 'Dockerfile'), 'FROM bb:arm AS base\nRUN echo built > /built\nFROM bb:arm\nCOPY --from=base /built /built\nCMD ["cat","/built"]\n');
      await d(['build', '-t', 'twostage', ctx], { env: { DOCKER_BUILDKIT: '0' }, timeout: 180000 });
      const out = (await d(['run', '--rm', 'twostage'])).stdout;
      if (out !== 'built') throw new Error(JSON.stringify(out));
    });

    await step('Rosetta runs an x86-64 static binary', async () => {
      const out = (await d(['run', '--rm', '--platform', 'linux/amd64', 'bb:amd', 'uname', '-m'])).stdout;
      if (out !== 'x86_64') throw new Error(JSON.stringify(out));
    });

    await step('no module request was refused except by design (dmesg), and loading is still disabled', async () => {
      const dmesg = (await d(['run', '--rm', '--cap-add', 'SYSLOG', 'bb:arm', 'dmesg'])).stdout;
      const refused = [...dmesg.matchAll(/localmost: module request "([^"]*)" \(([^)]*)\) refused/g)].map((m) => ({ req: m[1], mods: m[2].split(',') }));
      const unexpected = refused.filter((r) => !r.mods.some((m) => m in REFUSED_BY_DESIGN));
      if (unexpected.length) throw new Error(`refused: ${[...new Set(unexpected.map((r) => `${r.req} (${r.mods.join(',')})`))].join(', ')}`);
      const lockdown = await readLockdown();
      if (lockdown !== '1,1') throw new Error(`modules_disabled,kexec_load_disabled = ${lockdown}`);
      const byDesign = [...new Set(refused.map((r) => r.mods.join(',')))];
      return byDesign.length ? `refused by design only: ${byDesign.join(', ')}` : 'none refused';
    });

    await step('killing lm-agent (SIGKILL, in the guest) powers the VM off', async () => {
      const state = await conn.request('status', {}, 10000);
      if (state.dockerd !== 'running') throw new Error(`the VM is not up before the kill: ${JSON.stringify(state)}`);
      await inGuest(d, 'busybox kill -9 $(busybox pidof lm-agent)', { allowFail: true, timeout: 20000 });
      const exit = await Promise.race([vm.exited, sleep(30000).then(() => null)]);
      if (!exit) throw new Error('the VM did not power off within 30 s');
      const stopped = exit.events.find((e) => e.event === 'stopped');
      if (exit.code !== 0 || stopped?.reason !== 'guest') throw new Error(`vzrun ${exit.code}, ${JSON.stringify(stopped)}`);
      const line = fs.readFileSync(mainConsole, 'utf8').split('\n').find((l) => /the agent exited .*powering off/.test(l));
      if (!line) throw new Error('lm-init did not log the agent exit');
      return line.trim();
    });

    // ---- a second VM: Rosetta off ------------------------------------------------
    await step('without Rosetta: configure reports rosetta absent', async () => {
      const second = await bootJob({ vms, sockDir, name: 'nor', sharePath, rosetta: false, proxySock, console: path.join(work, 'nor-console.log') });
      try {
        if (!second.cfg.ok) throw new Error(`configure: ${second.cfg.code} ${second.cfg.message}`);
        if (second.cfg.rosetta !== 'absent') throw new Error(`rosetta: ${second.cfg.rosetta}`);
        const down = await second.conn.request('shutdown');
        const exit = await Promise.race([second.vm.exited, sleep(30000).then(() => null)]);
        if (!down.ok || !exit || exit.code !== 0) throw new Error('the shutdown op did not power the VM off');
        return 'absent; the shutdown op powered it off';
      } finally {
        await second.vm.stop();
      }
    });

    // ---- the hook's syscall tests, in the guest's own namespaces ----------------
    await step('lm-bindpin syscall tests pass in the guest (setns, openat2, statx, mount_setattr)', async () => {
      const con = path.join(work, 'hooktest-console.log');
      const tv = runVm({
        kernel: path.join(GUEST, 'vmlinux'),
        initrd: hookInitramfs,
        cmdline: 'console=hvc0 rdinit=/init quiet panic=-1',
        cpus: 2,
        memoryMiB: 2048,
        console: con,
        timeoutSec: 180,
        shares: [{ tag: 'work', path: sharePath, ro: false }],
      });
      vms.push(tv);
      const exit = await tv.exited;
      const text = fs.readFileSync(con, 'utf8');
      if (!/^HOOKTEST-OK$/m.test(text)) {
        throw new Error(`hook tests failed (vzrun ${exit.code}):\n${text.split('\n').filter((l) => /---|FAIL|PASS:|ok|panic/.test(l)).slice(-12).join('\n')}`);
      }
      return text.split('\n').filter((l) => /^--- PASS/.test(l)).length + ' tests';
    });
  } finally {
    // Stop only this run's VMs.
    await Promise.all(vms.map((v) => v.stop().catch(() => {})));
    if (proxy) proxy.close();
    fs.rmSync(sockDir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
    if (!process.env.LM_WORKDIR) fs.rmSync(workBase, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed (guest ${manifest.guestVersion}, rootfs.erofs ${manifest.artifacts['rootfs.erofs'].sha256.slice(0, 12)})`);
  if (passed !== results.length) process.exit(1);
}

main().catch((err) => {
  console.error(`acceptance: ${err.stack || err.message}`);
  process.exit(1);
});
