'use strict';

// Fetching the guest's pinned Alpine packages (contract §4.2, §4.3 step 1).
//
// A normal build checks only the lock: every package is downloaded from its
// pinned URL, and its sha256 and size must equal the lock's before it is put
// in the cache. `--update-lock` is the only step that trusts Alpine's
// signatures: it verifies each APKINDEX with the keys checked in under
// scripts/guest/keys/, resolves each set's dependency closure from it, checks
// every downloaded package's control segment against the signed index, and
// writes the new pins.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { gzipMembers, verifyApk } = require('./apk');
const { readTar } = require('./tar');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function httpsBytes(url) {
  const res = await fetch(url, { redirect: 'error' });
  if (!res.ok) throw new Error(`fetch: ${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const apkUrl = (lock, p) => `${lock.mirror}/${lock.branch}/${p.repo}/${p.arch}/${p.name}-${p.version}.apk`;
const cacheName = (p) => path.join(p.arch, `${p.name}-${p.version}.apk`);
const keyOf = (p) => `${p.name}@${p.arch}`;

function matches(file, p) {
  try {
    const buf = fs.readFileSync(file);
    return buf.length === p.size && sha256(buf) === p.sha256;
  } catch {
    return false;
  }
}

/** Writes `buf` to `dest` through a temporary file and a rename. */
function writeAtomic(dest, buf) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.tmp-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, buf, { flag: 'wx' });
  fs.renameSync(tmp, dest);
}

/**
 * Makes sure every locked package is in `cacheDir` with its pinned sha256
 * and size, downloading what is missing or does not match. A download that
 * does not match the lock fails the build and is never written. Returns
 * `{ "<name>@<arch>": <path> }`.
 */
async function ensurePackages(lock, cacheDir, { fetchBytes = httpsBytes } = {}) {
  const out = {};
  for (const p of lock.packages) {
    const dest = path.join(cacheDir, cacheName(p));
    if (!matches(dest, p)) {
      const buf = await fetchBytes(apkUrl(lock, p));
      if (buf.length !== p.size || sha256(buf) !== p.sha256) {
        throw new Error(`fetch: ${p.name}-${p.version} (${p.arch}) does not match its locked sha256 ${p.sha256}`);
      }
      writeAtomic(dest, buf);
    }
    out[keyOf(p)] = dest;
  }
  return out;
}

/**
 * Checks an APKINDEX.tar.gz's signature with a key from `keysDir` and returns
 * the index text. The first gzip member holds `.SIGN.RSA.<key>` (SHA-1) or
 * `.SIGN.RSA256.<key>` (SHA-256), a signature over every byte after it.
 */
function verifyIndex(buf, keysDir) {
  const members = gzipMembers(buf);
  if (members.length !== 2) throw new Error(`APKINDEX: expected 2 gzip members, found ${members.length}`);
  const sigEntry = readTar(members[0].data).find((e) => /^\.SIGN\.RSA(256)?\./.test(e.name));
  if (!sigEntry) throw new Error('APKINDEX: no signature');
  const m = /^\.SIGN\.RSA(256)?\.(.+)$/.exec(sigEntry.name);
  const keyName = m[2];
  const allowed = fs.readdirSync(keysDir).filter((n) => n.endsWith('.rsa.pub'));
  if (!allowed.includes(keyName)) throw new Error(`APKINDEX: signed by ${keyName}, which is not a checked-in key`);
  const key = fs.readFileSync(path.join(keysDir, keyName));
  const signed = buf.subarray(members[0].raw.length);
  if (!crypto.verify(m[1] ? 'sha256' : 'sha1', signed, key, sigEntry.data)) {
    throw new Error(`APKINDEX: signature by ${keyName} does not verify`);
  }
  const idx = readTar(members[1].data).find((e) => e.name === 'APKINDEX');
  if (!idx) throw new Error('APKINDEX: no APKINDEX member');
  return idx.data.toString('utf8');
}

/** The records of an APKINDEX: one object per package, keyed by field letter. */
function parseIndex(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    const r = {};
    for (const line of block.split('\n')) if (line.length > 2 && line[1] === ':') r[line[0]] = line.slice(2);
    if (r.P) out.push(r);
  }
  return out;
}

/** A dependency or provides token without its version constraint. */
const bare = (t) => t.split(/[=<>~]/)[0];

/**
 * The names of every package `roots` needs, in the order first reached.
 * A package named in `noDeps` (the kernel, whose apk we take files from but
 * never install) contributes no dependencies. A dependency is satisfied by a
 * package of that name, or else by the provider with the highest
 * `k:` priority; two equal providers are an error, so the choice is pinned.
 */
function resolveClosure(records, roots, { noDeps = [] } = {}) {
  const byName = new Map(records.map((r) => [r.P, r]));
  const providers = new Map();
  for (const r of records) {
    for (const p of (r.p ?? '').split(' ').filter(Boolean)) {
      const k = bare(p);
      if (!providers.has(k)) providers.set(k, []);
      providers.get(k).push(r);
    }
  }
  const pick = (dep) => {
    if (byName.has(dep)) return byName.get(dep);
    const cands = providers.get(dep) ?? [];
    if (cands.length === 0) throw new Error(`closure: nothing provides ${dep}`);
    const prio = (r) => Number(r.k ?? 0);
    const best = Math.max(...cands.map(prio));
    const top = cands.filter((r) => prio(r) === best);
    if (top.length > 1) throw new Error(`closure: ${dep} is provided by ${top.map((r) => r.P).join(', ')}; pin one`);
    return top[0];
  };
  const seen = [];
  const todo = [...roots];
  while (todo.length) {
    const dep = todo.shift();
    if (dep.startsWith('!')) continue;
    const r = pick(bare(dep));
    if (seen.includes(r.P)) continue;
    seen.push(r.P);
    if (!noDeps.includes(r.P)) todo.push(...(r.D ?? '').split(' ').filter(Boolean));
  }
  return seen;
}

/**
 * Resolves and pins every set in `spec` (the lock file without its
 * `packages`) and returns the whole new lock. Each apk is downloaded into
 * `cacheDir`, checked against the signed index, and hashed.
 */
async function updateLock(spec, { keysDir, fetchBytes = httpsBytes, cacheDir }) {
  const indexes = new Map(); // "<arch> <repos>" -> records
  const recordsFor = async (arch, repos) => {
    const key = `${arch} ${repos.join(',')}`;
    if (!indexes.has(key)) {
      const all = [];
      for (const repo of repos) {
        const url = `${spec.mirror}/${spec.branch}/${repo}/${arch}/APKINDEX.tar.gz`;
        for (const r of parseIndex(verifyIndex(await fetchBytes(url), keysDir))) all.push({ ...r, repo });
      }
      indexes.set(key, all);
    }
    return indexes.get(key);
  };
  const pins = new Map();
  for (const [set, { arch, roots, repos }] of Object.entries(spec.sets)) {
    const records = await recordsFor(arch, repos ?? spec.repos);
    for (const name of resolveClosure(records, roots, { noDeps: spec.kernelPackages ?? [] })) {
      const r = records.find((x) => x.P === name);
      const key = `${name}@${arch}`;
      if (!pins.has(key)) {
        const p = { name, version: r.V, repo: r.repo, arch, license: r.L ?? '', commit: r.c ?? '', C: r.C, sets: [] };
        const buf = await fetchBytes(apkUrl(spec, p));
        verifyApk(buf, r.C);
        writeAtomic(path.join(cacheDir, cacheName(p)), buf);
        pins.set(key, { ...p, sha256: sha256(buf), size: buf.length });
      }
      pins.get(key).sets.push(set);
    }
  }
  const packages = [...pins.values()]
    .sort((a, b) => (a.arch + a.name < b.arch + b.name ? -1 : 1))
    .map(({ name, version, repo, arch, sha256: h, size, license, commit, sets }) => ({
      name, version, repo, arch, sha256: h, size, license, commit, sets,
    }));
  return { ...spec, packages };
}

async function main(argv) {
  const root = path.resolve(__dirname, '..', '..');
  const lockPath = path.join(__dirname, 'packages.lock.json');
  const cacheDir = path.join(root, 'build', 'guest-cache', 'apks');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (argv.includes('--update-lock')) {
    const { packages: _old, ...spec } = lock;
    const next = await updateLock(spec, { keysDir: path.join(__dirname, 'keys'), cacheDir });
    fs.writeFileSync(lockPath, JSON.stringify(next, null, 2) + '\n');
    for (const p of next.packages) console.log(`${p.arch.padEnd(8)} ${p.repo.padEnd(10)} ${p.name.padEnd(28)} ${p.version}`);
    return;
  }
  await ensurePackages(lock, cacheDir);
  console.log(`fetch: ${lock.packages.length} packages checked in ${cacheDir}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { ensurePackages, verifyIndex, parseIndex, resolveClosure, updateLock, apkUrl, httpsBytes, keyOf };
