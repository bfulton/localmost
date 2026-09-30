'use strict';

const zlib = require('zlib');
const { moduleClosure, composeRootfs, composeInitramfs, DAEMON_JSON } = require('./compose');
const { readTar, writeTar } = require('./tar');
const { gzipMembers } = require('./apk');

const KVER = '6.18.54-0-virt';
const MOD = `lib/modules/${KVER}`;
const file = (name, data, mode = 0o644) => ({ name, type: 'file', mode, data: Buffer.from(data) });

const DEP = [
  'kernel/fs/ext4/ext4.ko.gz: kernel/lib/crc/crc16.ko.gz kernel/fs/mbcache.ko.gz kernel/fs/jbd2/jbd2.ko.gz',
  'kernel/fs/jbd2/jbd2.ko.gz:',
  'kernel/fs/mbcache.ko.gz:',
  'kernel/lib/crc/crc16.ko.gz:',
  'kernel/fs/fuse/virtiofs.ko.gz: kernel/fs/fuse/fuse.ko.gz',
  'kernel/fs/fuse/fuse.ko.gz:',
  'kernel/drivers/char/hw_random/virtio-rng.ko.gz:',
  'kernel/net/packet/af_packet.ko.gz:',
  '',
].join('\n');

const gz = (s) => zlib.gzipSync(Buffer.from(s));

function kernelEntries() {
  const mods = {
    'kernel/fs/ext4/ext4.ko.gz': 'ext4',
    'kernel/fs/jbd2/jbd2.ko.gz': 'jbd2',
    'kernel/fs/mbcache.ko.gz': 'mbcache',
    'kernel/lib/crc/crc16.ko.gz': 'crc16',
    'kernel/fs/fuse/virtiofs.ko.gz': 'virtiofs',
    'kernel/fs/fuse/fuse.ko.gz': 'fuse',
    'kernel/drivers/char/hw_random/virtio-rng.ko.gz': 'rng',
    'kernel/net/packet/af_packet.ko.gz': 'packet',
  };
  return [
    { name: 'boot/vmlinuz-virt', type: 'file', mode: 0o644, data: Buffer.from('kernel') },
    ...Object.entries(mods).map(([p, body]) => ({ name: `${MOD}/${p}`, type: 'file', mode: 0o644, data: gz(`ELF ${body}`) })),
    { name: `${MOD}/modules.dep`, type: 'file', mode: 0o644, data: Buffer.from(DEP) },
    { name: `${MOD}/modules.order`, type: 'file', mode: 0o644, data: Buffer.from(Object.keys(mods).map((m) => m.replace(/\.gz$/, '')).join('\n') + '\n') },
    { name: `${MOD}/modules.alias`, type: 'file', mode: 0o644, data: Buffer.from('alias fs-ext4 ext4\nalias net-pf-17 af_packet\n') },
    { name: `${MOD}/modules.builtin`, type: 'file', mode: 0o644, data: Buffer.from('kernel/fs/proc/proc.ko\n') },
    { name: `${MOD}/modules.dep.bin`, type: 'file', mode: 0o644, data: Buffer.from('binary') },
  ];
}

describe('moduleClosure', () => {
  it('takes the dependency closure of the roots, each module after what it needs', () => {
    const order = moduleClosure(DEP, ['ext4', 'virtiofs', 'virtio_rng']);
    expect(order).toEqual([
      'kernel/lib/crc/crc16.ko.gz',
      'kernel/fs/mbcache.ko.gz',
      'kernel/fs/jbd2/jbd2.ko.gz',
      'kernel/fs/ext4/ext4.ko.gz',
      'kernel/fs/fuse/fuse.ko.gz',
      'kernel/fs/fuse/virtiofs.ko.gz',
      'kernel/drivers/char/hw_random/virtio-rng.ko.gz',
    ]);
  });

  it('fails on a root that no module file provides', () => {
    expect(() => moduleClosure(DEP, ['ext4', 'nosuch'])).toThrow(/nosuch/);
  });
});

function composeFixture() {
  return composeRootfs({
    packages: [
      { name: 'runc', entries: [{ name: 'usr', type: 'dir', mode: 0o755 }, { name: 'usr/bin', type: 'dir', mode: 0o755 }, file('usr/bin/runc', 'REAL RUNC', 0o755)] },
      { name: 'busybox', entries: [file('bin/busybox', 'bb', 0o755)] },
      { name: 'iptables', entries: [file('usr/lib/xtables/libxt_DSCP.so', 'upper'), file('usr/lib/xtables/libxt_dscp.so', 'lower')] },
    ],
    kernel: kernelEntries(),
    moduleRoots: ['ext4', 'virtiofs'],
    binaries: { 'lm-init': Buffer.from('INIT'), 'lm-agent': Buffer.from('AGENT'), 'lm-runc': Buffer.from('WRAPPER'), 'lm-bindpin': Buffer.from('PIN') },
    x86Selftest: Buffer.from('X86 BUSYBOX'),
    release: { guestVersion: '2026.10.0', agentProtocol: 1, alpine: 'v3.24' },
  });
}

describe('composeRootfs', () => {
  const byName = (items) => Object.fromEntries(items.map((i) => [i.name, i]));

  it('stores the module closure uncompressed, as .ko, and rewrites modules.dep to match', () => {
    const { items, modules, kernelRelease } = composeFixture();
    const m = byName(items);
    expect(kernelRelease).toBe(KVER);
    expect(m[`${MOD}/kernel/fs/ext4/ext4.ko`].data.toString()).toBe('ELF ext4');
    expect(m[`${MOD}/kernel/fs/ext4/ext4.ko.gz`]).toBeUndefined();
    expect(m[`${MOD}/kernel/net/packet/af_packet.ko`]).toBeUndefined(); // not in the allowlist
    const dep = m[`${MOD}/modules.dep`].data.toString();
    expect(dep).toContain('kernel/fs/ext4/ext4.ko: kernel/lib/crc/crc16.ko kernel/fs/mbcache.ko kernel/fs/jbd2/jbd2.ko');
    expect(dep).not.toContain('.ko.gz');
    expect(dep).not.toContain('af_packet');
    expect(m[`${MOD}/modules.dep.bin`]).toBeUndefined();
    expect(modules).toEqual(['crc16', 'mbcache', 'jbd2', 'ext4', 'fuse', 'virtiofs']);
    expect(m['etc/localmost/modules'].data.toString().split('\n').filter(Boolean)).toEqual([
      'kernel/lib/crc/crc16.ko', 'kernel/fs/mbcache.ko', 'kernel/fs/jbd2/jbd2.ko', 'kernel/fs/ext4/ext4.ko',
      'kernel/fs/fuse/fuse.ko', 'kernel/fs/fuse/virtiofs.ko',
    ]);
  });

  it('has /var/run -> ../run, and lm-runc at /usr/bin/runc with the real runc moved aside', () => {
    const m = byName(composeFixture().items);
    expect(m['var/run']).toMatchObject({ type: 'symlink', linkname: '../run' });
    expect(m['usr/bin/runc'].data.toString()).toBe('WRAPPER');
    expect(m['usr/libexec/localmost/runc'].data.toString()).toBe('REAL RUNC');
    expect(m['sbin/lm-init'].data.toString()).toBe('INIT');
    expect(m['sbin/modprobe']).toMatchObject({ type: 'symlink', linkname: 'lm-init' });
    expect(m['usr/libexec/localmost/x86_64/busybox'].mode).toBe(0o755);
  });

  it('writes daemon.json exactly and the resolver that points at the relay address', () => {
    const m = byName(composeFixture().items);
    expect(JSON.parse(m['etc/docker/daemon.json'].data.toString())).toEqual(DAEMON_JSON);
    expect(m['etc/resolv.conf'].data.toString()).toBe('nameserver 198.18.0.1\n');
    expect(JSON.parse(m['etc/localmost/release.json'].data.toString())).toMatchObject({ guestVersion: '2026.10.0' });
  });

  it('keeps names that differ only in case, and survives a round trip through the tar writer', () => {
    const entries = readTar(writeTar(composeFixture().items));
    const names = entries.map((e) => e.name);
    expect(names).toContain('usr/lib/xtables/libxt_DSCP.so');
    expect(names).toContain('usr/lib/xtables/libxt_dscp.so');
    for (const d of ['dev', 'proc', 'sys', 'run', 'tmp', 'var/lib/docker', 'var/lib/containerd', 'etc/docker', 'Users', 'Volumes', 'private']) {
      expect(entries.find((e) => e.name === d)?.type).toBe('dir');
    }
  });

  it('refuses two packages that ship different files at one path', () => {
    expect(() =>
      composeRootfs({
        packages: [
          { name: 'a', entries: [file('usr/bin/x', 'one')] },
          { name: 'b', entries: [file('usr/bin/x', 'two')] },
        ],
        kernel: kernelEntries(),
        moduleRoots: ['ext4'],
        binaries: { 'lm-init': Buffer.from(''), 'lm-agent': Buffer.from(''), 'lm-runc': Buffer.from(''), 'lm-bindpin': Buffer.from('') },
        x86Selftest: Buffer.from(''),
        release: {},
      }),
    ).toThrow(/usr\/bin\/x/);
  });
});

describe('composeInitramfs', () => {
  it('holds busybox, the modules to mount the root, and an /init that loads them in order', () => {
    const out = composeInitramfs({ busyboxStatic: Buffer.from('BB'), kernel: kernelEntries(), moduleRoots: ['virtiofs'], init: (mods) => `#!/bin/busybox sh\n# ${mods.join(' ')}\n` });
    expect(gzipMembers(out)).toHaveLength(1);
    const text = zlib.gunzipSync(out).toString('latin1');
    expect(text).toContain('bin/busybox');
    expect(text).toContain('lib/fuse.ko');
    expect(text).toContain('lib/virtiofs.ko');
    expect(text).toContain('# fuse virtiofs');
    expect(text).toContain('TRAILER!!!');
  });
});
