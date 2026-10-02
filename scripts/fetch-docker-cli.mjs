#!/usr/bin/env node
/**
 * Fetch the docker CLI the app bundles for jobs (`npm run fetch:docker-cli`).
 *
 * Without Docker Desktop, a job has no `docker` of its own; the app ships a
 * pinned static CLI at Resources/docker-cli/docker and puts it first on the
 * job's PATH. scripts/docker-cli.lock.json names the release: its URL, the
 * sha256 of the .tgz and the one member to take from it.
 *
 * The tarball is downloaded into memory and checked against the lock before
 * anything is written; a mismatch writes nothing. A tarball that matches is
 * kept in build/docker-cli-cache/<sha256>.tgz, so the next run needs no
 * download. Only the member is extracted, and only if it is a regular file
 * holding a thin arm64 Mach-O executable, to build/docker-cli/docker. That
 * directory is what packaging copies, so nothing else is put in it.
 *
 *   node scripts/fetch-docker-cli.mjs [--lock <file>] [--out <dir>] [--cache <dir>]
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Parser } from 'tar';

const require = createRequire(import.meta.url);
const { checkArm64Executable } = require('./check-vm-resources.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Docker's static macOS builds for Apple silicon, and nothing else.
const URL_PREFIX = 'https://download.docker.com/mac/static/stable/aarch64/';
// Far above the ~20 MB tarball and ~43 MB CLI, and far below what would
// exhaust memory.
const MAX_BYTES = 256 * 1024 * 1024;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Read the lock and refuse any field outside its allowed form. */
function readLock(lockFile) {
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
  const fields = ['member', 'sha256', 'url', 'version'];
  if (Object.keys(lock).sort().join() !== fields.join()) {
    throw new Error(`${lockFile} must hold exactly ${fields.join(', ')}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(lock.version)) {
    throw new Error(`${lockFile}: version ${JSON.stringify(lock.version)} is not x.y.z`);
  }
  if (lock.url !== `${URL_PREFIX}docker-${lock.version}.tgz`) {
    throw new Error(`${lockFile}: url must be ${URL_PREFIX}docker-${lock.version}.tgz`);
  }
  if (!/^[0-9a-f]{64}$/.test(lock.sha256)) {
    throw new Error(`${lockFile}: sha256 must be 64 lower-case hex digits`);
  }
  if (lock.member !== 'docker/docker') {
    throw new Error(`${lockFile}: member must be docker/docker`);
  }
  return lock;
}

/** The download.docker.com fetch, bounded. */
async function httpsDownload(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url}: HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_BYTES) {
    throw new Error(`GET ${url}: ${declared} bytes is more than ${MAX_BYTES}`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_BYTES) {
      throw new Error(`GET ${url}: more than ${MAX_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The one member's bytes from a .tgz in memory; throws unless it is there exactly once, as a regular file. */
function extractMember(tgz, member) {
  return new Promise((resolve, reject) => {
    const found = [];
    let failed = null;
    const fail = (err) => {
      failed ??= err;
    };
    const parser = new Parser({
      strict: true,
      onReadEntry(entry) {
        if (entry.path !== member) {
          entry.resume();
          return;
        }
        if (entry.type !== 'File') {
          fail(new Error(`${member} in the tarball is not a regular file (${entry.type})`));
          entry.resume();
          return;
        }
        if (entry.size > MAX_BYTES) {
          fail(new Error(`${member} in the tarball is more than ${MAX_BYTES} bytes`));
          entry.resume();
          return;
        }
        const chunks = [];
        entry.on('data', (chunk) => chunks.push(chunk));
        entry.on('end', () => found.push(Buffer.concat(chunks)));
      },
    });
    parser.on('error', fail);
    parser.on('warn', (code, message) => fail(new Error(`the tarball is malformed: ${code} ${message}`)));
    parser.on('close', () => {
      if (failed) reject(failed);
      else if (found.length > 1) reject(new Error(`${member} is in the tarball more than once`));
      else if (found.length === 0) reject(new Error(`${member} is not in the tarball`));
      else resolve(found[0]);
    });
    parser.end(tgz);
  });
}

/** Write `data` to `file` by a rename from a temporary name in `tmpDir` (same volume). */
function writeAtomically(file, data, mode, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, data, { mode, flag: 'wx' });
    fs.chmodSync(tmp, mode);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Put the locked docker CLI at <outDir>/docker. `download` takes a URL and
 * returns its bytes; tests replace it.
 */
export async function fetchDockerCli({
  lockFile = path.join(REPO, 'scripts', 'docker-cli.lock.json'),
  outDir = path.join(REPO, 'build', 'docker-cli'),
  cacheDir = path.join(REPO, 'build', 'docker-cli-cache'),
  download = httpsDownload,
  log = (message) => console.log(message),
} = {}) {
  const lock = readLock(lockFile);
  const cached = path.join(cacheDir, `${lock.sha256}.tgz`);

  let tgz = fs.existsSync(cached) ? fs.readFileSync(cached) : null;
  if (tgz && sha256(tgz) !== lock.sha256) {
    log(`docker CLI: ${cached} does not match its hash; downloading again`);
    tgz = null;
  }
  const downloaded = !tgz;
  if (downloaded) {
    log(`docker CLI: downloading ${lock.url}`);
    tgz = await download(lock.url);
    const actual = sha256(tgz);
    if (actual !== lock.sha256) {
      throw new Error(`${lock.url}: sha256 is ${actual}, but ${lockFile} says ${lock.sha256}`);
    }
  }

  const cli = await extractMember(tgz, lock.member);
  checkArm64Executable(cli, `${lock.member} from ${lock.url}`);

  if (downloaded) {
    writeAtomically(cached, tgz, 0o644, cacheDir);
  }
  const out = path.join(outDir, 'docker');
  if (fs.existsSync(out) && fs.readFileSync(out).equals(cli) && (fs.statSync(out).mode & 0o777) === 0o755) {
    log(`docker CLI: ${out} is already docker ${lock.version}`);
    return out;
  }
  writeAtomically(out, cli, 0o755, cacheDir);
  log(`docker CLI: wrote docker ${lock.version} to ${out}`);
  return out;
}

function parseArgs(argv) {
  const flags = { '--lock': 'lockFile', '--out': 'outDir', '--cache': 'cacheDir' };
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]];
    if (!key || argv[i + 1] === undefined) {
      throw new Error(`usage: fetch-docker-cli.mjs [--lock <file>] [--out <dir>] [--cache <dir>]`);
    }
    options[key] = path.resolve(argv[i + 1]);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await fetchDockerCli(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`fetch-docker-cli: ${err.message}`);
    process.exit(1);
  }
}
