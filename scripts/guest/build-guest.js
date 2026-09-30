'use strict';

// npm run build:guest: builds the guest image into build/guest (contract
// §4.3). It runs on the owner's Mac, outside any localmost job: it boots
// VMs, which a job's seatbelt profile and hosted CI runners do not allow.
//
//   node scripts/guest/build-guest.js [--verify-reproducible] [--force]
//
// The output is cached under a hash of every input (the lock file, guest/,
// scripts/guest/, and the Go and zlib versions); a second run with the same
// inputs is a cache hit. --verify-reproducible builds the artifacts a second
// time from scratch, in the same checkout, and fails unless they are
// byte-identical. --force ignores the cache.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { ensurePackages } = require('./fetch');
const { readApk } = require('./apk');
const { unzboot } = require('./unzboot');
const { writeTar } = require('./tar');
const { composeRootfs, composeInitramfs, composeBuildInitramfs } = require('./compose');
const { runVm } = require('./vm');
const { connectAgent, docker } = require('./guestio');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'build', 'guest');
const CACHE = path.join(ROOT, 'build', 'guest-cache');
const LOCK = path.join(__dirname, 'packages.lock.json');

const GUEST_VERSION = '2026.10.0';
const DATA_FORMAT = 1;
const AGENT_PROTOCOL = 1;

/** The module allowlist's roots (contract §5.2). The build takes their closure. */
const MODULE_ROOTS = [
  'virtiofs', 'vmw_vsock_virtio_transport', 'virtio_blk', 'virtio-rng', 'ext4', 'erofs', 'overlay',
  'br_netfilter', 'veth', 'dummy', 'nf_tables', 'nft_compat', 'nft_chain_nat', 'nft_nat', 'nft_masq',
  'xt_addrtype', 'xt_conntrack', 'xt_MASQUERADE', 'xt_nat', 'xt_mark', 'xt_tcpudp', 'xt_set', 'ip_set_hash_net',
  'nf_conntrack_netlink', 'ipt_REJECT', 'iptable_filter', 'iptable_nat', 'binfmt_misc',
];
const INITRAMFS_MODULES = ['virtio_blk', 'erofs'];
const BUILD_VM_MODULES = ['virtiofs', 'virtio_blk', 'erofs', 'loop', 'ext4'];

/** The /info fields the manifest's baseline keeps: the filter's allowlist without the VM's size. */
const BASELINE_FIELDS = ['ServerVersion', 'OSType', 'Architecture', 'OperatingSystem', 'KernelVersion', 'Driver', 'CgroupVersion', 'SecurityOptions'];

/** moby v29.5.3's contrib/check-config.sh, as checked in. */
const CHECK_CONFIG_SHA256 = '3ec868d650d91b54e4b6e070966afde03a9ac6463982b4eb83ebd0dc47c7bd62';

const ARTIFACTS = ['vmlinux', 'initramfs.cpio.gz', 'rootfs.erofs'];
const CMDLINE = 'console=hvc0 rdinit=/init ro quiet panic=-1 ipv6.disable=1';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sha256File = (p) => sha256(fs.readFileSync(p));
const log = (s) => console.log(`build:guest: ${s}`);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** The cache key: every input file's path and bytes, and the toolchains that shape the output. */
function cacheKey() {
  const h = crypto.createHash('sha256');
  for (const f of [...walk(path.join(ROOT, 'guest')), ...walk(__dirname)]) {
    h.update(path.relative(ROOT, f)).update('\0').update(fs.readFileSync(f)).update('\0');
  }
  h.update(execFileSync('go', ['version'], { cwd: path.join(ROOT, 'guest') }));
  h.update(`zlib ${process.versions.zlib}`);
  return h.digest('hex');
}

function cacheHit(key) {
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(CACHE, 'built.json'), 'utf8'));
    if (stamp.key !== key) return false;
    for (const [name, hash] of Object.entries(stamp.outputs)) {
      if (sha256File(path.join(OUT, name)) !== hash) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---- artifacts -----------------------------------------------------------------

function goBuild(binDir) {
  const env = {
    ...process.env,
    GOOS: 'linux',
    GOARCH: 'arm64',
    CGO_ENABLED: '0',
    GOCACHE: path.join(CACHE, 'go', 'build'),
    GOMODCACHE: path.join(CACHE, 'go', 'mod'),
    GOFLAGS: '-modcacherw',
  };
  const out = {};
  for (const cmd of ['lm-init', 'lm-agent', 'lm-runc', 'lm-bindpin']) {
    const dest = path.join(binDir, cmd);
    execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w -buildid=', '-o', dest, `./cmd/${cmd}`], {
      cwd: path.join(ROOT, 'guest'),
      env,
      stdio: 'inherit',
    });
    out[cmd] = fs.readFileSync(dest);
  }
  return out;
}

function initScript(mods) {
  // The initramfs's /init (contract §3.2 step 1).
  return `#!/bin/busybox sh
/bin/busybox mount -t devtmpfs devtmpfs /dev
${mods.map((m) => `/bin/busybox insmod /lib/${m}.ko || { echo "localmost initramfs: insmod ${m} failed" > /dev/hvc0; /bin/busybox poweroff -f; }`).join('\n')}
/bin/busybox mount -t erofs -o ro /dev/vda /newroot || { echo "localmost initramfs: the root did not mount" > /dev/hvc0; /bin/busybox poweroff -f; }
/bin/busybox mount --move /dev /newroot/dev
exec /bin/busybox switch_root /newroot /sbin/lm-init
`;
}

function parseCheckConfig(text) {
  // The report's "Generally Necessary" section: every CONFIG_ it lists must
  // be enabled. Color codes are stripped.
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  const start = clean.indexOf('Generally Necessary:');
  const end = clean.indexOf('Optional Features:');
  if (start < 0 || end < start) throw new Error('check-config: no Generally Necessary section in the report');
  const section = clean.slice(start, end);
  const checked = [...section.matchAll(/(CONFIG_[A-Z0-9_]+): ([a-z (]+)/g)].map((m) => ({ flag: m[1], state: m[2].trim() }));
  if (checked.length < 20) throw new Error(`check-config: only ${checked.length} flags in the report`);
  const missing = checked.filter((c) => !c.state.startsWith('enabled'));
  return { checked: checked.length, missing: missing.map((m) => m.flag) };
}

/** Builds vmlinux, the initramfs and the erofs root into `work`. */
async function buildArtifacts(work, lock, apkPaths) {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, 'in'), { recursive: true });
  fs.mkdirSync(path.join(work, 'out'));
  fs.mkdirSync(path.join(work, 'bin'));
  const apk = (name, arch = 'aarch64') => readApk(fs.readFileSync(apkPaths[`${name}@${arch}`]));
  const inSet = (set) => lock.packages.filter((p) => p.sets.includes(set));
  const kernelPkg = inSet('guest').find((p) => lock.kernelPackages.includes(p.name));
  const kernel = apk(kernelPkg.name).entries;
  const file = (entries, name) => {
    const e = entries.find((x) => x.name === name && x.type === 'file');
    if (!e) throw new Error(`no ${name}`);
    return e.data;
  };

  log('unpacking the kernel');
  const vmlinux = unzboot(file(kernel, 'boot/vmlinuz-virt'));
  fs.writeFileSync(path.join(work, 'vmlinux'), vmlinux);
  const config = kernel.find((e) => /^boot\/config-/.test(e.name));
  // gzipped: check-config.sh greps it through zcat when zgrep is missing, as in busybox.
  fs.writeFileSync(path.join(work, 'in', 'kernel.config.gz'), zlib.gzipSync(config.data));
  const cc = fs.readFileSync(path.join(__dirname, 'check-config.sh'));
  if (sha256(cc) !== CHECK_CONFIG_SHA256) throw new Error('check-config.sh is not the pinned moby v29.5.3 file');
  fs.writeFileSync(path.join(work, 'in', 'check-config.sh'), cc);

  log('building the guest programs');
  const binaries = goBuild(path.join(work, 'bin'));

  log('composing the root');
  const busyboxStatic = file(apk('busybox-static').entries, 'bin/busybox.static');
  const x86 = file(apk('busybox-static', 'x86_64').entries, 'bin/busybox.static');
  const packages = inSet('guest')
    .filter((p) => p !== kernelPkg && p.arch === 'aarch64')
    .map((p) => ({ name: p.name, entries: apk(p.name).entries }));
  const root = composeRootfs({
    packages,
    kernel,
    moduleRoots: MODULE_ROOTS,
    binaries,
    x86Selftest: x86,
    release: { guestVersion: GUEST_VERSION, agentProtocol: AGENT_PROTOCOL, dataFormat: DATA_FORMAT, alpine: lock.branch, alpineRelease: lock.release },
  });
  fs.writeFileSync(path.join(work, 'in', 'rootfs.tar'), writeTar(root.items));
  fs.writeFileSync(
    path.join(work, 'initramfs.cpio.gz'),
    composeInitramfs({ busyboxStatic, kernel, moduleRoots: INITRAMFS_MODULES, init: initScript }),
  );
  const buildPackages = inSet('build')
    .filter((p) => p !== kernelPkg && p.name !== 'busybox-static')
    .map((p) => ({ name: p.name, entries: apk(p.name).entries }));
  const buildInitramfs = path.join(work, 'build-initramfs.cpio.gz');
  fs.writeFileSync(
    buildInitramfs,
    composeBuildInitramfs({ busyboxStatic, packages: buildPackages, kernel, moduleRoots: BUILD_VM_MODULES, init: fs.readFileSync(path.join(__dirname, 'build-init')) }),
  );

  log('running the build VM (mkfs.erofs)');
  const console_ = path.join(work, 'build-console.log');
  const vm = runVm({
    kernel: path.join(work, 'vmlinux'),
    initrd: buildInitramfs,
    cmdline: 'console=hvc0 rdinit=/init quiet panic=-1',
    cpus: 4,
    memoryMiB: 2048,
    console: console_,
    timeoutSec: 600,
    shares: [
      { tag: 'share', path: path.join(work, 'in'), ro: true },
      { tag: 'out', path: path.join(work, 'out'), ro: false },
    ],
  });
  const res = await vm.exited;
  const text = fs.readFileSync(console_, 'utf8');
  if (res.code !== 0 || !/^BUILD-OK$/m.test(text)) {
    throw new Error(`the build VM failed (exit ${res.code}):\n${text.split('\n').slice(-15).join('\n')}`);
  }
  const check = parseCheckConfig(fs.readFileSync(path.join(work, 'out', 'check-config.txt'), 'utf8'));
  if (check.missing.length) throw new Error(`the kernel lacks generally necessary options: ${check.missing.join(', ')}`);
  log(`check-config: ${check.checked} generally necessary options enabled`);
  fs.renameSync(path.join(work, 'out', 'rootfs.erofs'), path.join(work, 'rootfs.erofs'));
  return { work, modules: root.modules, kernelRelease: root.kernelRelease, kernelPackage: kernelPkg };
}

// ---- smoke boot ------------------------------------------------------------------

function sparseFile(p, bytes) {
  fs.rmSync(p, { force: true });
  const fd = fs.openSync(p, 'wx', 0o600);
  fs.ftruncateSync(fd, bytes);
  fs.closeSync(fd);
}

/**
 * Boots the new guest in refresh mode on a scratch data disk (contract
 * §4.3 step 7): hello, configure, then /_ping, /version and /info from the
 * daemon, then shutdown. Returns what the manifest records and the raw
 * answers (the fixture the filter's baseline test compares against).
 */
async function smoke(work) {
  log('smoke boot');
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmg-'));
  const disk = path.join(work, 'smoke-data.img');
  sparseFile(disk, 8 * 1024 ** 3);
  const agentSock = path.join(sockDir, 'agent.sock');
  const dockerSock = path.join(sockDir, 'docker.sock');
  const t0 = Date.now();
  const vm = runVm({
    kernel: path.join(work, 'vmlinux'),
    initrd: path.join(work, 'initramfs.cpio.gz'),
    cmdline: `${CMDLINE} lm.mode=refresh`,
    cpus: 2,
    memoryMiB: 2048,
    console: path.join(work, 'smoke-console.log'),
    timeoutSec: 180,
    disks: [
      { path: path.join(work, 'rootfs.erofs'), ro: true, sync: 'full' },
      { path: disk, ro: false, sync: 'none' },
    ],
    vsock: [
      { port: 1025, path: agentSock },
      { port: 2375, path: dockerSock },
    ],
  });
  try {
    await vm.started;
    const { conn, hello } = await connectAgent(agentSock);
    const helloMs = Date.now() - t0;
    const cfg = await conn.request('configure', { vmId: '0-000000000000', mode: 'refresh', timeUnixMs: Date.now(), rosetta: false });
    const configureMs = Date.now() - t0;
    if (!cfg.ok) throw new Error(`configure failed: ${cfg.code} ${cfg.message}`);
    log(`hello at ${helloMs} ms, configure done at ${configureMs} ms (dockerd ${cfg.docker.version})`);
    const answers = {};
    for (const [key, method, p] of [['ping', 'GET', '/_ping'], ['pingHead', 'HEAD', '/_ping'], ['version', 'GET', '/version'], ['info', 'GET', '/info']]) {
      const r = await docker(dockerSock, method, p);
      const headers = { ...r.headers };
      delete headers.date;
      answers[key] = { status: r.status, headers, body: r.body.length && /json/.test(r.headers['content-type'] ?? '') ? JSON.parse(r.body) : r.body.toString('utf8') };
    }
    const version = answers.version.body;
    const component = (name) => (version.Components ?? []).find((c) => c.Name === name)?.Version;
    const info = answers.info.body;
    const baseline = Object.fromEntries(BASELINE_FIELDS.map((f) => [f, info[f]]));
    const status = await conn.request('status');
    const down = await conn.request('shutdown');
    if (!down.ok) throw new Error('shutdown was refused');
    const exit = await vm.exited;
    if (exit.code !== 0) throw new Error(`the smoke VM did not power off cleanly (vzrun ${exit.code})`);
    return {
      hello: hello,
      timings: { helloMs, configureMs },
      status,
      docker: {
        engine: version.Version,
        apiVersion: version.ApiVersion,
        minApiVersion: version.MinAPIVersion,
        containerd: (component('containerd') ?? '').replace(/^v/, ''),
        runc: component('runc') ?? '',
      },
      baseline,
      answers,
    };
  } finally {
    await vm.stop();
    fs.rmSync(sockDir, { recursive: true, force: true });
    fs.rmSync(disk, { force: true });
  }
}

// ---- outputs -----------------------------------------------------------------------

function licenses(lock, guestPkgs) {
  const rows = guestPkgs.map((p) => `| ${p.name} | ${p.version} | ${p.arch} | ${p.license} | \`${p.commit}\` |`);
  return `# Licenses of the localmost guest image

The guest image (\`vmlinux\`, \`initramfs.cpio.gz\`, \`rootfs.erofs\`) is built
from the Alpine Linux ${lock.release} packages below (branch ${lock.branch}),
unmodified, and from localmost's own guest programs.

| Package | Version | Arch | License | Alpine aports commit |
|---|---|---|---|---|
${rows.join('\n')}

localmost's guest programs (\`lm-init\`, \`lm-agent\`, \`lm-runc\`,
\`lm-bindpin\`) are built from the \`guest/\` directory of localmost's source,
under localmost's license (GPL-3.0). They include the Go standard library
and golang.org/x/sys (BSD-3-Clause).

**Source offer.** The complete corresponding source of every package above
is Alpine's aports tree at the commit listed for it, with the upstream
source tarballs its APKBUILD names. localmost attaches the aports commit and
the upstream tarballs for linux, busybox, iptables and e2fsprogs to each
release that ships this image, and will provide any other on request, for
three years from that release.
`;
}

function writeOutputs(built, smokeResult, lock) {
  const staging = path.join(CACHE, 'staging');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const artifacts = {};
  for (const name of ARTIFACTS) {
    fs.copyFileSync(path.join(built.work, name), path.join(staging, name));
    const buf = fs.readFileSync(path.join(staging, name));
    artifacts[name] = { sha256: sha256(buf), size: buf.length };
  }
  const guestPkgs = lock.packages.filter((p) => p.sets.includes('guest') || p.sets.includes('x86_64-selftest'));
  const manifest = {
    schema: 1,
    guestVersion: GUEST_VERSION,
    dataFormat: DATA_FORMAT,
    agentProtocol: AGENT_PROTOCOL,
    alpine: { branch: lock.branch, release: lock.release },
    kernel: { package: `${built.kernelPackage.name}-${built.kernelPackage.version}`, release: built.kernelRelease },
    docker: smokeResult.docker,
    artifacts,
    modules: built.modules,
    packages: guestPkgs.map((p) => ({ name: p.name, version: p.version, arch: p.arch, repo: p.repo, sha256: p.sha256, license: p.license })),
    baseline: smokeResult.baseline,
  };
  fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(staging, 'LICENSES.md'), licenses(lock, guestPkgs));
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.renameSync(staging, OUT);
  fs.writeFileSync(path.join(CACHE, 'smoke.json'), JSON.stringify(smokeResult, null, 2) + '\n');
  return manifest;
}

async function main(argv) {
  const verify = argv.includes('--verify-reproducible');
  const force = argv.includes('--force');
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  fs.mkdirSync(CACHE, { recursive: true });
  const key = cacheKey();
  if (!force && cacheHit(key)) {
    log(`cache hit (${key.slice(0, 12)}): build/guest is up to date`);
  } else {
    log('fetching packages');
    const apkPaths = await ensurePackages(lock, path.join(CACHE, 'apks'));
    const built = await buildArtifacts(path.join(CACHE, 'work'), lock, apkPaths);
    const smokeResult = await smoke(built.work);
    writeOutputs(built, smokeResult, lock);
    const outputs = Object.fromEntries(fs.readdirSync(OUT).map((n) => [n, sha256File(path.join(OUT, n))]));
    fs.writeFileSync(path.join(CACHE, 'built.json'), JSON.stringify({ key, outputs }, null, 2) + '\n');
    log(`wrote ${Object.keys(outputs).join(', ')} to ${path.relative(ROOT, OUT)}`);
  }
  if (verify) {
    log('--verify-reproducible: building the artifacts again from scratch');
    const apkPaths = await ensurePackages(lock, path.join(CACHE, 'apks'));
    const again = await buildArtifacts(path.join(CACHE, 'work-verify'), lock, apkPaths);
    const differ = ARTIFACTS.filter((n) => sha256File(path.join(again.work, n)) !== sha256File(path.join(OUT, n)));
    fs.rmSync(again.work, { recursive: true, force: true });
    if (differ.length) throw new Error(`not reproducible: ${differ.join(', ')} differ between two builds`);
    log(`reproducible: ${ARTIFACTS.join(', ')} are byte-identical across two builds`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`build:guest: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseCheckConfig, MODULE_ROOTS, GUEST_VERSION };
