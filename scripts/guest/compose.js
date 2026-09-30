'use strict';

// Composes the guest's read-only root and its two initramfs files from apk
// data tars held in memory (contract §3.3, §4.3 step 5). Nothing is ever
// extracted onto the Mac's case-insensitive filesystem.

const path = require('path');
const zlib = require('zlib');
const { newc, gzipFixed } = require('./cpio');

/** /etc/docker/daemon.json, exactly as the contract gives it (§3.3). */
const DAEMON_JSON = {
  hosts: ['unix:///run/docker.sock'],
  'storage-driver': 'overlay2',
  features: { 'containerd-snapshotter': false },
  iptables: true,
  ip6tables: false,
  ipv6: false,
  'userland-proxy': false,
  'live-restore': false,
  dns: ['198.18.0.1'],
  'log-driver': 'json-file',
  'log-opts': { 'max-size': '10m', 'max-file': '2' },
};

/** Empty directories the root needs as mount points and state directories. */
const ROOT_DIRS = [
  'dev', 'proc', 'sys', 'run', 'tmp', 'mnt', 'root',
  'etc/docker', 'etc/localmost', 'usr/libexec/localmost',
  'var/lib/docker', 'var/lib/containerd', 'var/log', 'var/tmp',
];

const modName = (p) => path.posix.basename(p).replace(/\.ko(\.gz)?$/, '').replace(/-/g, '_');

function parseDep(text) {
  const deps = new Map();
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    deps.set(line.slice(0, colon), line.slice(colon + 1).trim().split(/\s+/).filter(Boolean));
  }
  return deps;
}

/**
 * The module files `roots` need, from modules.dep, ordered so that every
 * module comes after the modules it depends on. Roots are module names;
 * `-` and `_` are the same, as modprobe treats them.
 */
function moduleClosure(depText, roots) {
  const deps = parseDep(depText);
  const byName = new Map([...deps.keys()].map((p) => [modName(p), p]));
  const order = [];
  const visit = (p, trail) => {
    if (order.includes(p)) return;
    if (trail.includes(p)) throw new Error(`modules: dependency cycle at ${p}`);
    for (const d of deps.get(p) ?? []) {
      if (!deps.has(d)) throw new Error(`modules: ${p} needs ${d}, which modules.dep does not list`);
      visit(d, [...trail, p]);
    }
    order.push(p);
  };
  for (const r of roots) {
    const p = byName.get(r.replace(/-/g, '_'));
    if (!p) throw new Error(`modules: no module named ${r}`);
    visit(p, []);
  }
  return order;
}

const unGz = (p) => p.replace(/\.ko\.gz$/, '.ko');

/** The kernel apk's module directory: its release and its files, keyed by path under it. */
function kernelModules(kernel) {
  const releases = new Set();
  const files = new Map();
  for (const e of kernel) {
    const m = /^lib\/modules\/([^/]+)\/(.+)$/.exec(e.name);
    if (!m) continue;
    releases.add(m[1]);
    if (e.type === 'file') files.set(m[2], e.data);
  }
  if (releases.size !== 1) throw new Error(`kernel: expected one module release, found ${[...releases].join(', ')}`);
  const [release] = releases;
  if (!files.has('modules.dep')) throw new Error('kernel: no modules.dep');
  return { release, files };
}

/** Adds `name` and its parent directories to `out` (a Map of items), refusing conflicts. */
function adder(out) {
  const addDir = (name, mode = 0o755) => {
    const parts = name.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      const have = out.get(d);
      if (!have) out.set(d, { name: d, type: 'dir', mode: i === parts.length ? mode : 0o755 });
      else if (have.type !== 'dir') throw new Error(`compose: ${d} is both a directory and a ${have.type}`);
    }
  };
  const add = (item, from) => {
    if (item.type === 'dir') return addDir(item.name, item.mode);
    const parent = path.posix.dirname(item.name);
    if (parent !== '.') addDir(parent);
    const have = out.get(item.name);
    if (have) {
      const same =
        have.type === item.type &&
        (item.type === 'file' ? Buffer.compare(have.data, item.data) === 0 : have.linkname === item.linkname);
      if (!same) throw new Error(`compose: ${item.name} from ${from} conflicts with what is already there`);
      return;
    }
    out.set(item.name, item);
  };
  return { add, addDir, remove: (n) => out.delete(n) };
}

function entryItem(e, pkg) {
  switch (e.type) {
    case 'dir':
      return { name: e.name, type: 'dir', mode: e.mode & 0o7777 };
    case 'file':
      return { name: e.name, type: 'file', mode: e.mode & 0o7777, data: e.data };
    case 'symlink':
      return { name: e.name, type: 'symlink', mode: 0o777, linkname: e.linkname };
    case 'link':
      return { name: e.name, type: 'link', mode: e.mode & 0o7777, linkname: e.linkname };
    default:
      throw new Error(`compose: ${pkg} ships ${e.name} of type ${JSON.stringify(e.type)}, which the guest does not take`);
  }
}

/**
 * The root's entries, as items for writeTar.
 *
 * - `packages`: `[{ name, entries }]`, each apk's data tar (not the kernel).
 * - `kernel`: the kernel apk's entries; only the module closure of
 *   `moduleRoots` is taken, uncompressed, with modules.dep, .order, .alias
 *   and .builtin (text only; the .bin indexes would name .ko.gz files).
 * - `binaries`: lm-init, lm-agent, lm-runc and lm-bindpin.
 * - `x86Selftest`: the x86_64 static busybox for the Rosetta self-test.
 * - `release`: written to /etc/localmost/release.json for `hello`.
 */
function composeRootfs({ packages, kernel, moduleRoots, binaries, x86Selftest, release }) {
  const out = new Map();
  const { add, addDir, remove } = adder(out);
  for (const pkg of packages) for (const e of pkg.entries) add(entryItem(e, pkg.name), pkg.name);

  // The module closure, stored uncompressed: erofs compresses the whole root.
  const { release: kver, files } = kernelModules(kernel);
  const order = moduleClosure(files.get('modules.dep').toString('utf8'), moduleRoots);
  const base = `lib/modules/${kver}`;
  for (const p of order) {
    const data = files.get(p);
    if (!data) throw new Error(`modules: ${p} is in modules.dep but not in the kernel package`);
    add({ name: `${base}/${unGz(p)}`, type: 'file', mode: 0o644, data: p.endsWith('.gz') ? zlib.gunzipSync(data) : data }, 'kernel');
  }
  const taken = new Set(order);
  const depLines = files.get('modules.dep').toString('utf8').split('\n').filter((l) => taken.has(l.split(':')[0]));
  add({ name: `${base}/modules.dep`, type: 'file', mode: 0o644, data: Buffer.from(unGzText(depLines.join('\n') + '\n')) }, 'kernel');
  const kept = new Set(order.map(unGz));
  if (files.has('modules.order')) {
    const lines = unGzText(files.get('modules.order').toString('utf8')).split('\n').filter((l) => kept.has(l));
    add({ name: `${base}/modules.order`, type: 'file', mode: 0o644, data: Buffer.from(lines.join('\n') + '\n') }, 'kernel');
  }
  for (const f of ['modules.alias', 'modules.builtin']) {
    if (files.has(f)) add({ name: `${base}/${f}`, type: 'file', mode: 0o644, data: Buffer.from(unGzText(files.get(f).toString('utf8'))) }, 'kernel');
  }

  // runc moves aside; the wrapper takes its name (contract §3.7).
  const realRunc = out.get('usr/bin/runc');
  if (!realRunc || realRunc.type !== 'file') throw new Error('compose: no usr/bin/runc in the packages');
  remove('usr/bin/runc');
  add({ ...realRunc, name: 'usr/libexec/localmost/runc' }, 'runc');
  const exe = (name, data) => add({ name, type: 'file', mode: 0o755, data }, 'localmost');
  exe('usr/bin/runc', binaries['lm-runc']);
  exe('sbin/lm-init', binaries['lm-init']);
  exe('usr/libexec/localmost/lm-agent', binaries['lm-agent']);
  exe('usr/libexec/localmost/lm-bindpin', binaries['lm-bindpin']);
  exe('usr/libexec/localmost/x86_64-selftest', x86Selftest);
  // The kernel's usermode helper and dockerd both run /sbin/modprobe; lm-init
  // answers as modprobe once loading is disabled (it loads nothing).
  add({ name: 'sbin/modprobe', type: 'symlink', mode: 0o777, linkname: 'lm-init' }, 'localmost');

  const text = (name, s) => add({ name, type: 'file', mode: 0o644, data: Buffer.from(s) }, 'localmost');
  text('etc/docker/daemon.json', JSON.stringify(DAEMON_JSON, null, 2) + '\n');
  text('etc/resolv.conf', 'nameserver 198.18.0.1\n');
  text('etc/hostname', 'localmost\n');
  text('etc/passwd', 'root:x:0:0:root:/root:/bin/sh\n');
  text('etc/group', 'root:x:0:root\n');
  text(
    'etc/os-release',
    `NAME="localmost guest"\nID=alpine\nVERSION_ID=${release.alpineRelease ?? ''}\nPRETTY_NAME="localmost guest (Alpine Linux ${release.alpine ?? ''})"\n`,
  );
  text('etc/localmost/release.json', JSON.stringify(release, null, 2) + '\n');
  text('etc/localmost/modules', order.map(unGz).join('\n') + '\n');

  for (const d of ROOT_DIRS) addDir(d);
  add({ name: 'var/run', type: 'symlink', mode: 0o777, linkname: '../run' }, 'localmost');

  return { items: [...out.values()], modules: order.map(modName), kernelRelease: kver };
}

function unGzText(s) {
  return s.replace(/\.ko\.gz\b/g, '.ko');
}

/** The modules for an initramfs, flat under lib/, in load order. */
function initramfsModules(kernel, moduleRoots) {
  const { files } = kernelModules(kernel);
  const order = moduleClosure(files.get('modules.dep').toString('utf8'), moduleRoots);
  return order.map((p) => {
    const data = files.get(p);
    return { name: `lib/${path.posix.basename(unGz(p))}`, mode: 0o100644, data: p.endsWith('.gz') ? zlib.gunzipSync(data) : data };
  });
}

/**
 * The guest's initramfs: static busybox, the modules that mount the erofs
 * root (and their dependencies), and `/init`, made by `init(modules)` from
 * the ordered module names. gzip with a fixed header.
 */
function composeInitramfs({ busyboxStatic, kernel, moduleRoots, init }) {
  const mods = initramfsModules(kernel, moduleRoots);
  const entries = [
    ...['bin', 'dev', 'lib', 'newroot', 'proc', 'sys'].map((name) => ({ name, mode: 0o040755 })),
    { name: 'bin/busybox', mode: 0o100755, data: busyboxStatic },
    ...mods,
    { name: 'init', mode: 0o100755, data: Buffer.from(init(mods.map((m) => modName(m.name)))) },
  ];
  return gzipFixed(newc(entries));
}

/**
 * The build VM's initramfs: static busybox, the build set's packages
 * (erofs-utils, e2fsprogs and their libraries), the modules it mounts the
 * shares and checks the image with, and `/init` from build-init.
 */
function composeBuildInitramfs({ busyboxStatic, packages, kernel, moduleRoots, init }) {
  const out = new Map();
  const { add, addDir } = adder(out);
  for (const pkg of packages) for (const e of pkg.entries) add(entryItem(e, pkg.name), pkg.name);
  for (const d of ['dev', 'proc', 'sys', 'in', 'out', 'mnt/r', 'tmp', 'lib']) addDir(d);
  const mods = initramfsModules(kernel, moduleRoots);
  const entries = [];
  const S = { file: 0o100000, dir: 0o040000, symlink: 0o120000 };
  for (const it of out.values()) {
    if (it.name === 'bin/busybox') continue;
    if (it.type === 'link') {
      // newc could share an inode; a copy of the target's bytes is simpler.
      const target = out.get(it.linkname);
      if (!target || target.type !== 'file') throw new Error(`compose: hard link ${it.name} to ${it.linkname} has no file`);
      entries.push({ name: it.name, mode: S.file | target.mode, data: target.data });
    } else if (it.type === 'symlink') {
      entries.push({ name: it.name, mode: S.symlink | 0o777, data: Buffer.from(it.linkname) });
    } else {
      entries.push({ name: it.name, mode: S[it.type] | it.mode, data: it.data });
    }
  }
  entries.push({ name: 'bin/busybox', mode: 0o100755, data: busyboxStatic });
  entries.push(...mods.filter((m) => !out.has(m.name)));
  entries.push({ name: 'etc/build-modules', mode: 0o100644, data: Buffer.from(mods.map((m) => path.posix.basename(m.name)).join('\n') + '\n') });
  entries.push({ name: 'init', mode: 0o100755, data: init });
  if (!out.has('etc')) entries.push({ name: 'etc', mode: 0o040755 });
  return gzipFixed(newc(entries));
}

module.exports = { moduleClosure, composeRootfs, composeInitramfs, composeBuildInitramfs, kernelModules, DAEMON_JSON };
