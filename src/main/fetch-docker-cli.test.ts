/**
 * scripts/fetch-docker-cli.mjs: the pinned docker CLI the app bundles for
 * jobs (Resources/docker-cli/docker). The script is an ES module, which jest
 * cannot load in-process, so each case runs it in a child node, with the
 * download replaced by a function that serves a tarball built here.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'fetch-docker-cli.mjs');
const LOCK = path.join(REPO, 'scripts', 'docker-cli.lock.json');

// The first bytes of a thin arm64 Mach-O executable: MH_MAGIC_64,
// CPU_TYPE_ARM64, CPU_SUBTYPE_ARM64_ALL, MH_EXECUTE.
const machO = (cpuType: number, fileType = 2, magic = 0xfeedfacf, cpuSubtype = 0) => {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(magic, 0);
  header.writeUInt32LE(cpuType, 4);
  header.writeUInt32LE(cpuSubtype, 8);
  header.writeUInt32LE(fileType, 12);
  return Buffer.concat([header, Buffer.from('the docker cli')]);
};
const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;
const CLI = machO(ARM64);

const sha256 = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');

describe('fetching the bundled docker CLI', () => {
  let scratch: string;
  let outDir: string;
  let cacheDir: string;

  // Lay out files under a staging directory and pack them as a .tgz, the
  // shape download.docker.com serves: docker/docker and its siblings.
  const pack = (files: { [name: string]: Buffer | { link: string } }, entries = Object.keys(files)) => {
    const staging = fs.mkdtempSync(path.join(scratch, 'staging-'));
    for (const [name, body] of Object.entries(files)) {
      const file = path.join(staging, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (Buffer.isBuffer(body)) {
        fs.writeFileSync(file, body, { mode: 0o755 });
      } else {
        fs.symlinkSync(body.link, file);
      }
    }
    const tgz = path.join(scratch, `${path.basename(staging)}.tgz`);
    tar.c({ gzip: true, file: tgz, cwd: staging, sync: true, portable: true }, entries);
    return tgz;
  };

  const DEFAULT_FILES = {
    'docker/docker': CLI,
    'docker/docker-compose': Buffer.from('not wanted'),
    'docker/README.md': Buffer.from('not wanted either'),
  };

  const lockFor = (tgz: string, overrides: Record<string, string> = {}) => {
    const lock = {
      version: '29.8.1',
      url: 'https://download.docker.com/mac/static/stable/aarch64/docker-29.8.1.tgz',
      sha256: sha256(fs.readFileSync(tgz)),
      member: 'docker/docker',
      ...overrides,
    };
    const file = path.join(scratch, 'docker-cli.lock.json');
    fs.writeFileSync(file, JSON.stringify(lock));
    return file;
  };

  // Run fetchDockerCli in a child node. `serve` is the file the download
  // returns, or null for a download that must not happen.
  const fetchWith = (lockFile: string, serve: string | null) => {
    const harness = `
      import * as fs from 'node:fs';
      import { pathToFileURL } from 'node:url';
      // One JSON argument: were the script's path argv[1], it would take
      // itself to be run from the command line.
      const { script, lockFile, outDir, cacheDir, serve } = JSON.parse(process.argv[1]);
      const { fetchDockerCli } = await import(pathToFileURL(script).href);
      const requested = [];
      const download = async (url) => {
        requested.push(url);
        if (serve === null) throw new Error('no download expected');
        return fs.readFileSync(serve);
      };
      try {
        await fetchDockerCli({ lockFile, outDir, cacheDir, download, log: () => {} });
        process.stdout.write(JSON.stringify({ ok: true, requested }));
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, error: err.message, requested }));
      }
    `;
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', harness, JSON.stringify({ script: SCRIPT, lockFile, outDir, cacheDir, serve })],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return JSON.parse(out) as { ok: boolean; error?: string; requested: string[] };
  };

  // Every file under dir, relative to it.
  const tree = (dir: string): string[] =>
    fs.existsSync(dir)
      ? (fs.readdirSync(dir, { recursive: true }) as string[]).map(String).sort()
      : [];

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-docker-cli-')));
    outDir = path.join(scratch, 'build', 'docker-cli');
    cacheDir = path.join(scratch, 'build', 'docker-cli-cache');
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('pins the release the contract names', () => {
    expect(JSON.parse(fs.readFileSync(LOCK, 'utf-8'))).toEqual({
      version: '29.8.1',
      url: 'https://download.docker.com/mac/static/stable/aarch64/docker-29.8.1.tgz',
      sha256: '5a8f5604d7673202b2af925229d15eb4bbb86f7f542e4ac8cd7aa3f14cfa0f8b',
      member: 'docker/docker',
    });
  });

  it('extracts the member, executable, and nothing else', () => {
    const tgz = pack(DEFAULT_FILES);
    const lock = lockFor(tgz);

    const result = fetchWith(lock, tgz);

    expect(result).toEqual({ ok: true, requested: [JSON.parse(fs.readFileSync(lock, 'utf-8')).url] });
    expect(tree(outDir)).toEqual(['docker']);
    expect(fs.readFileSync(path.join(outDir, 'docker'))).toEqual(CLI);
    expect(fs.statSync(path.join(outDir, 'docker')).mode & 0o777).toBe(0o755);
    // Nothing is left behind in build/ but the output and the cached tarball.
    expect(tree(path.join(scratch, 'build'))).toEqual(
      ['docker-cli', 'docker-cli/docker', 'docker-cli-cache', `docker-cli-cache/${sha256(fs.readFileSync(tgz))}.tgz`].sort(),
    );
  });

  it('fails on a hash mismatch and writes nothing', () => {
    const tgz = pack(DEFAULT_FILES);
    const lock = lockFor(tgz, { sha256: 'f'.repeat(64) });

    const result = fetchWith(lock, tgz);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sha256/);
    expect(result.error).toContain(sha256(fs.readFileSync(tgz)));
    expect(tree(path.join(scratch, 'build'))).toEqual([]);
  });

  it('leaves a CLI already in place alone when the hash does not match', () => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'docker'), 'the last good one');
    const tgz = pack(DEFAULT_FILES);
    const lock = lockFor(tgz, { sha256: '0'.repeat(64) });

    expect(fetchWith(lock, tgz).ok).toBe(false);
    expect(fs.readFileSync(path.join(outDir, 'docker'), 'utf-8')).toBe('the last good one');
  });

  it('uses the cached tarball without downloading it again', () => {
    const tgz = pack(DEFAULT_FILES);
    const lock = lockFor(tgz);
    expect(fetchWith(lock, tgz).ok).toBe(true);
    fs.rmSync(outDir, { recursive: true });

    const again = fetchWith(lock, null);

    expect(again).toEqual({ ok: true, requested: [] });
    expect(fs.readFileSync(path.join(outDir, 'docker'))).toEqual(CLI);
  });

  it('downloads again over a cached tarball that no longer matches its hash', () => {
    const tgz = pack(DEFAULT_FILES);
    const lock = lockFor(tgz);
    const hex = sha256(fs.readFileSync(tgz));
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, `${hex}.tgz`), 'truncated');

    const result = fetchWith(lock, tgz);

    expect(result.ok).toBe(true);
    expect(result.requested).toHaveLength(1);
    expect(sha256(fs.readFileSync(path.join(cacheDir, `${hex}.tgz`)))).toBe(hex);
  });

  type Files = Record<string, Buffer | { link: string }>;
  it.each<[string, Files, string[] | undefined, RegExp]>([
    ['a missing member', { 'docker/other': CLI }, undefined, /docker\/docker/],
    ['a member that is a link', { 'docker/docker': { link: '/bin/sh' } }, undefined, /not a regular file/],
    ['a member that appears twice', DEFAULT_FILES, ['docker/docker', 'docker/docker'], /more than once/],
    ['an Intel binary', { 'docker/docker': machO(X86_64) }, undefined, /arm64/],
    ['a universal binary', { 'docker/docker': machO(ARM64, 2, 0xbebafeca) }, undefined, /arm64/],
    // With the pointer-authentication ABI bit, as Apple's toolchain writes it.
    ['an arm64e binary', { 'docker/docker': machO(ARM64, 2, 0xfeedfacf, 0x80000002) }, undefined, /arm64/],
    ['a library rather than an executable', { 'docker/docker': machO(ARM64, 6) }, undefined, /arm64/],
    ['a script', { 'docker/docker': Buffer.from('#!/bin/sh\necho docker\n') }, undefined, /arm64/],
  ])('refuses %s and writes no CLI', (_what, files, entries, error) => {
    const tgz = pack(files, entries);
    const lock = lockFor(tgz);

    const result = fetchWith(lock, tgz);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(error);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it.each([
    ['plain http', { url: 'http://download.docker.com/mac/static/stable/aarch64/docker-29.8.1.tgz' }],
    ['another host', { url: 'https://example.com/mac/static/stable/aarch64/docker-29.8.1.tgz' }],
    ['a look-alike host', { url: 'https://download.docker.com.example.com/mac/static/stable/aarch64/docker-29.8.1.tgz' }],
    ['an Intel build', { url: 'https://download.docker.com/mac/static/stable/x86_64/docker-29.8.1.tgz' }],
    ['a short hash', { sha256: 'abc' }],
    ['a member outside the archive root', { member: '../docker' }],
  ])('refuses a lock naming %s before downloading anything', (_what, overrides) => {
    const tgz = pack(DEFAULT_FILES);
    const lock = lockFor(tgz, overrides);

    const result = fetchWith(lock, null);

    expect(result.ok).toBe(false);
    expect(result.requested).toEqual([]);
    expect(tree(path.join(scratch, 'build'))).toEqual([]);
  });

  it('runs from the command line, and exits non-zero on a refused lock', () => {
    const tgz = pack(DEFAULT_FILES);
    const lock = lockFor(tgz, { url: 'http://example.com/docker.tgz' });

    const run = spawnSync(process.execPath, [SCRIPT, '--lock', lock, '--out', outDir, '--cache', cacheDir], {
      encoding: 'utf-8',
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/download\.docker\.com/);
    expect(tree(path.join(scratch, 'build'))).toEqual([]);
  });
});
