/**
 * What the Docker VM backend puts in the app's Resources, and the checks the
 * build makes before it packages them: the helper (localmost-vm), the guest
 * image (guest/) and the docker CLI jobs run (docker-cli/docker). They come
 * from `npm run build:native` into build/. forge.config.js runs
 * checkVmResources in prePackage, so a build never ships without its VM, or
 * with anything beside it; scripts/fetch-docker-cli.mjs uses the Mach-O check
 * on the CLI it extracts.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Exactly what Resources/guest may hold; anything else fails the build.
const GUEST_FILES = ['LICENSES.md', 'initramfs.cpio.gz', 'manifest.json', 'rootfs.erofs', 'vmlinux'];
// The guest files manifest.json hashes: the ones the VM boots from.
const GUEST_ARTIFACTS = ['initramfs.cpio.gz', 'rootfs.erofs', 'vmlinux'];
// Exactly what Resources/docker-cli may hold.
const DOCKER_CLI_FILES = ['docker'];

const BUILD_HINT = 'run `npm run build:native` (outside any localmost job)';

// The first four fields of a thin 64-bit Mach-O header, little-endian.
const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
// Plain arm64. The subtype's top byte holds capability bits, so compare the
// rest: arm64e (2) is refused, since a stock Mac does not run third-party
// arm64e code.
const CPU_SUBTYPE_ARM64_ALL = 0;
const CPU_SUBTYPE_MASK = 0x00ffffff;
const MH_EXECUTE = 2;

/**
 * Throw unless `bytes` begins a thin arm64 Mach-O executable: not a
 * universal file, not Intel or arm64e, not a library or a script. `what`
 * names the file in the message.
 */
function checkArm64Executable(bytes, what) {
  const ok =
    bytes.length >= 16 &&
    bytes.readUInt32LE(0) === MH_MAGIC_64 &&
    bytes.readUInt32LE(4) === CPU_TYPE_ARM64 &&
    (bytes.readUInt32LE(8) & CPU_SUBTYPE_MASK) === CPU_SUBTYPE_ARM64_ALL &&
    bytes.readUInt32LE(12) === MH_EXECUTE;
  if (!ok) {
    throw new Error(`${what} is not a thin arm64 Mach-O executable`);
  }
}

/** lstat that names the build step on a missing file. */
function lstatOrExplain(file, what) {
  try {
    return fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`${what} is missing: ${file}; ${BUILD_HINT}`);
    }
    throw err;
  }
}

/** Throw unless `dir` is a real directory holding exactly `allowed`. */
function checkDirectoryHolds(dir, allowed, what) {
  if (!lstatOrExplain(dir, what).isDirectory()) {
    throw new Error(`${what} must be a directory, not a link or a file: ${dir}`);
  }
  const present = fs.readdirSync(dir).sort();
  const extra = present.filter((name) => !allowed.includes(name));
  const missing = allowed.filter((name) => !present.includes(name));
  if (extra.length > 0) {
    throw new Error(`${what} holds files it must not ship: ${extra.join(', ')} (in ${dir})`);
  }
  if (missing.length > 0) {
    throw new Error(`${what} is missing ${missing.join(', ')} (in ${dir}); ${BUILD_HINT}`);
  }
  for (const name of allowed) {
    if (!fs.lstatSync(path.join(dir, name)).isFile()) {
      throw new Error(`${what}: ${name} must be a regular file, not a link or a directory (in ${dir})`);
    }
  }
}

/** Throw unless `file` is a regular, executable, thin arm64 Mach-O file. */
function checkExecutable(file, what) {
  const stat = lstatOrExplain(file, what);
  if (!stat.isFile()) {
    throw new Error(`${what} must be a regular file, not a link or a directory: ${file}`);
  }
  if ((stat.mode & 0o111) === 0) {
    throw new Error(`${what} is not executable: ${file}`);
  }
  const header = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  checkArm64Executable(header, `${what} (${file})`);
}

/** The sha256 and size of a file, read in chunks: rootfs.erofs is ~100 MB. */
function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const chunk = Buffer.alloc(1 << 20);
  const fd = fs.openSync(file, 'r');
  let size = 0;
  try {
    for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0; ) {
      hash.update(chunk.subarray(0, n));
      size += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest('hex'), size };
}

/** Throw unless the guest's artifacts are exactly those manifest.json names, with its hashes and sizes. */
function checkGuestManifest(guestDir) {
  const manifestFile = path.join(guestDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
  } catch (err) {
    throw new Error(`the guest's manifest.json cannot be read: ${err.message} (${manifestFile})`);
  }
  if (manifest === null || typeof manifest !== 'object' || manifest.schema !== 1) {
    throw new Error(`the guest's manifest.json must have schema 1 (${manifestFile})`);
  }
  const artifacts = manifest.artifacts;
  if (artifacts === null || typeof artifacts !== 'object') {
    throw new Error(`the guest's manifest.json has no artifacts (${manifestFile})`);
  }
  const named = Object.keys(artifacts).sort();
  if (named.join() !== GUEST_ARTIFACTS.join()) {
    throw new Error(
      `the guest's manifest.json must name exactly ${GUEST_ARTIFACTS.join(', ')}, not ${named.join(', ')} (${manifestFile})`,
    );
  }
  for (const name of GUEST_ARTIFACTS) {
    const expected = artifacts[name];
    if (
      expected === null ||
      typeof expected !== 'object' ||
      typeof expected.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(expected.sha256) ||
      !Number.isSafeInteger(expected.size) ||
      expected.size < 0
    ) {
      throw new Error(`the guest's manifest.json has no valid sha256 and size for ${name} (${manifestFile})`);
    }
    const actual = hashFile(path.join(guestDir, name));
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      throw new Error(
        `guest ${name} is ${actual.size} bytes with sha256 ${actual.sha256}, ` +
          `but manifest.json says ${expected.size} bytes with sha256 ${expected.sha256}; ${BUILD_HINT}`,
      );
    }
  }
}

/**
 * Throw unless build/ holds what the app's Resources must: the helper, the
 * guest (exactly GUEST_FILES, matching its manifest) and the docker CLI
 * (exactly `docker`). Each path is checked as found, never followed through
 * a link.
 */
function checkVmResources({ helper, guestDir, dockerCliDir }) {
  checkExecutable(helper, 'the VM helper localmost-vm');
  checkDirectoryHolds(guestDir, GUEST_FILES, 'the guest directory');
  checkGuestManifest(guestDir);
  checkDirectoryHolds(dockerCliDir, DOCKER_CLI_FILES, 'the docker CLI directory');
  checkExecutable(path.join(dockerCliDir, 'docker'), 'the docker CLI');
}

module.exports = { GUEST_FILES, checkArm64Executable, checkVmResources };
