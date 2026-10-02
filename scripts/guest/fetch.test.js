'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { writeTar } = require('./tar');
const { ensurePackages, verifyIndex, parseIndex, resolveClosure, updateLock } = require('./fetch');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const file = (name, data) => ({ name, type: 'file', mode: 0o644, data: Buffer.from(data) });

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-fetch-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const baseLock = (packages) => ({
  mirror: 'https://mirror.test/alpine',
  branch: 'v3.24',
  packages,
});

describe('ensurePackages', () => {
  const good = Buffer.from('the real package');
  const pkg = { name: 'musl', version: '1.2.6-r2', repo: 'main', arch: 'aarch64', sha256: sha256(good), size: good.length };

  it('fails on a hash mismatch and writes nothing', async () => {
    const cache = path.join(tmp, 'apks');
    const fetchBytes = async () => Buffer.from('a different package');
    await expect(ensurePackages(baseLock([pkg]), cache, { fetchBytes })).rejects.toThrow(/sha256/);
    const left = fs.existsSync(cache) ? fs.readdirSync(cache, { recursive: true }) : [];
    expect(left.filter((n) => !fs.statSync(path.join(cache, n)).isDirectory())).toEqual([]);
  });

  it('downloads from the pinned URL once, then uses the checked cache', async () => {
    const cache = path.join(tmp, 'apks');
    const urls = [];
    const fetchBytes = async (url) => {
      urls.push(url);
      return good;
    };
    const first = await ensurePackages(baseLock([pkg]), cache, { fetchBytes });
    const second = await ensurePackages(baseLock([pkg]), cache, { fetchBytes });
    expect(urls).toEqual(['https://mirror.test/alpine/v3.24/main/aarch64/musl-1.2.6-r2.apk']);
    expect(fs.readFileSync(first['musl@aarch64']).equals(good)).toBe(true);
    expect(second).toEqual(first);
  });

  it('downloads again over a cached file that no longer matches', async () => {
    const cache = path.join(tmp, 'apks');
    const fetchBytes = async () => good;
    const paths = await ensurePackages(baseLock([pkg]), cache, { fetchBytes });
    fs.writeFileSync(paths['musl@aarch64'], 'tampered');
    await ensurePackages(baseLock([pkg]), cache, { fetchBytes });
    expect(fs.readFileSync(paths['musl@aarch64']).equals(good)).toBe(true);
  });
});

// ---- a signed fixture repository -------------------------------------------

function makeApk(name, version, files) {
  const data = zlib.gzipSync(writeTar(files.map(([n, d]) => file(n, d))));
  const pkginfo = `pkgname = ${name}\npkgver = ${version}\ndatahash = ${sha256(data)}\n`;
  const control = zlib.gzipSync(writeTar([file('.PKGINFO', pkginfo)]).subarray(0, 1024));
  const signature = zlib.gzipSync(writeTar([file('.SIGN.RSA.unused.rsa.pub', 'x')]).subarray(0, 1024));
  return { apk: Buffer.concat([signature, control, data]), C: 'Q1' + crypto.createHash('sha1').update(control).digest('base64') };
}

function makeRepo({ keyName = 'test@example.org-1.rsa.pub', privateKey, records }) {
  const text = records
    .map((r) => Object.entries(r).map(([k, v]) => `${k}:${v}`).join('\n'))
    .join('\n\n') + '\n\n';
  const body = zlib.gzipSync(writeTar([file('DESCRIPTION', 'v3.24'), file('APKINDEX', text)]));
  const sig = crypto.sign('sha1', body, privateKey);
  const sigSeg = zlib.gzipSync(writeTar([file(`.SIGN.RSA.${keyName}`, sig)]).subarray(0, 1024));
  return Buffer.concat([sigSeg, body]);
}

function fixtureWorld() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keysDir = path.join(tmp, 'keys');
  fs.mkdirSync(keysDir);
  fs.writeFileSync(path.join(keysDir, 'test@example.org-1.rsa.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
  const apks = {
    musl: makeApk('musl', '1.2.6-r2', [['lib/ld-musl-aarch64.so.1', 'musl']]),
    'busybox-binsh': makeApk('busybox-binsh', '1.37.0-r31', [['bin/sh', 'sh']]),
    runc: makeApk('runc', '1.4.3-r1', [['usr/bin/runc', 'runc']]),
    'linux-virt': makeApk('linux-virt', '6.18.54-r0', [['boot/vmlinuz-virt', 'k']]),
    mkinitfs: makeApk('mkinitfs', '3.0-r0', [['sbin/mkinitfs', 'm']]),
  };
  const rec = (name, version, extra) => ({ C: apks[name].C, P: name, V: version, A: 'aarch64', S: apks[name].apk.length, L: 'MIT', c: 'deadbeef', ...extra });
  const records = [
    rec('musl', '1.2.6-r2', { p: 'so:libc.musl-aarch64.so.1=1' }),
    rec('busybox-binsh', '1.37.0-r31', { p: '/bin/sh cmd:sh=1.37.0-r31', k: '100', D: 'so:libc.musl-aarch64.so.1' }),
    rec('runc', '1.4.3-r1', { D: 'so:libc.musl-aarch64.so.1 /bin/sh !runc-doc' }),
    rec('linux-virt', '6.18.54-r0', { D: 'initramfs-generator' }),
    rec('mkinitfs', '3.0-r0', { p: 'initramfs-generator' }),
  ];
  const index = makeRepo({ privateKey, records });
  const urls = {
    'https://mirror.test/alpine/v3.24/main/aarch64/APKINDEX.tar.gz': index,
  };
  for (const r of records) urls[`https://mirror.test/alpine/v3.24/main/aarch64/${r.P}-${r.V}.apk`] = apks[r.P].apk;
  const fetchBytes = async (url) => {
    if (!urls[url]) throw new Error(`404 ${url}`);
    return urls[url];
  };
  return { keysDir, privateKey, records, urls, fetchBytes, apks };
}

const lockSpec = {
  mirror: 'https://mirror.test/alpine',
  branch: 'v3.24',
  repos: ['main'],
  sets: {
    guest: { arch: 'aarch64', roots: ['runc', 'linux-virt'] },
  },
  kernelPackages: ['linux-virt'],
};

describe('verifyIndex', () => {
  it('accepts an index signed by a checked-in key and returns its text', () => {
    const { keysDir, urls } = fixtureWorld();
    const text = verifyIndex(urls['https://mirror.test/alpine/v3.24/main/aarch64/APKINDEX.tar.gz'], keysDir);
    expect(parseIndex(text).map((r) => r.P)).toContain('runc');
  });

  it('refuses an index whose body was changed after signing', () => {
    const { keysDir, privateKey, records } = fixtureWorld();
    const index = makeRepo({ privateKey, records });
    const [sigLen] = [index.indexOf(Buffer.from([0x1f, 0x8b]), 10)];
    const forged = Buffer.concat([index.subarray(0, sigLen), zlib.gzipSync(writeTar([file('APKINDEX', 'P:evil\nV:1\n\n')]))]);
    expect(() => verifyIndex(forged, keysDir)).toThrow(/signature/);
  });

  it('refuses an index signed by a key that is not checked in', () => {
    const { keysDir, records } = fixtureWorld();
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(() => verifyIndex(makeRepo({ privateKey: other, records }), keysDir)).toThrow(/signature/);
    expect(() => verifyIndex(makeRepo({ keyName: 'stranger.rsa.pub', privateKey: other, records }), keysDir)).toThrow(/stranger/);
  });
});

describe('resolveClosure', () => {
  it('follows so: and path provides, skips conflicts, and takes no dependencies of a kernel package', () => {
    const { records } = fixtureWorld();
    const names = resolveClosure(parseIndex(records.map((r) => Object.entries(r).map(([k, v]) => `${k}:${v}`).join('\n')).join('\n\n')), ['runc', 'linux-virt'], { noDeps: ['linux-virt'] });
    expect(names.sort()).toEqual(['busybox-binsh', 'linux-virt', 'musl', 'runc']);
  });

  it('fails on a dependency nothing provides', () => {
    expect(() => resolveClosure(parseIndex('P:a\nV:1\nD:so:libnothing.so.1\n\n'), ['a'])).toThrow(/libnothing/);
  });
});

describe('updateLock', () => {
  it('pins every package of the closure with its sha256, size, license and commit', async () => {
    const { keysDir, fetchBytes, apks } = fixtureWorld();
    const lock = await updateLock(lockSpec, { keysDir, fetchBytes, cacheDir: path.join(tmp, 'apks') });
    const runc = lock.packages.find((p) => p.name === 'runc');
    expect(runc).toEqual({
      name: 'runc', version: '1.4.3-r1', repo: 'main', arch: 'aarch64',
      sha256: sha256(apks.runc.apk), size: apks.runc.apk.length, license: 'MIT', commit: 'deadbeef', sets: ['guest'],
    });
    expect(lock.packages.map((p) => p.name).sort()).toEqual(['busybox-binsh', 'linux-virt', 'musl', 'runc']);
  });

  it('refuses a package whose control segment does not match the signed index', async () => {
    const world = fixtureWorld();
    world.urls['https://mirror.test/alpine/v3.24/main/aarch64/runc-1.4.3-r1.apk'] = makeApk('runc', '1.4.3-r1', [['usr/bin/runc', 'evil']]).apk;
    await expect(updateLock(lockSpec, { keysDir: world.keysDir, fetchBytes: world.fetchBytes, cacheDir: path.join(tmp, 'apks') })).rejects.toThrow(/control/);
  });
});
