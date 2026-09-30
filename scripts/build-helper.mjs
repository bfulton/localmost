#!/usr/bin/env node
// Builds localmost-vm, the helper that runs one Linux VM per Docker-using job
// (docs/roadmap/vm-docker-backend-contract.md, section 7.3).
//
// It is built for release on arm64 from native/localmost-vm, copied to
// build/localmost-vm, and ad-hoc signed there with the virtualization
// entitlement, so that development runs can start VMs. That is the path
// helperPath() gives an unpackaged app and the one the packager copies into
// Resources; osx-sign re-signs it with the app's identity when there is one.
//
// It is cached: SwiftPM rebuilds only what changed, and the copy and signing
// are skipped when the binary and the entitlements are what was last signed.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = join(ROOT, 'native', 'localmost-vm');
const SCRATCH = join(ROOT, 'build', 'swift', 'localmost-vm');
const OUTPUT = join(ROOT, 'build', 'localmost-vm');
const STAMP = `${OUTPUT}.stamp`;
const ENTITLEMENTS = join(ROOT, 'packaging', 'entitlements.virtualization.plist');

function fail(message) {
  console.error(`build:helper: ${message}`);
  process.exit(1);
}

function run(file, args) {
  return execFileSync(file, args, { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  fail('the helper uses Virtualization.framework and builds only on Apple silicon macOS');
}
if (!existsSync(ENTITLEMENTS)) {
  fail(`${ENTITLEMENTS} is missing; it holds the one entitlement the helper is signed with`);
}

const swiftArgs = ['build', '-c', 'release', '--arch', 'arm64', '--package-path', PACKAGE, '--scratch-path', SCRATCH];
run('/usr/bin/xcrun', ['swift', ...swiftArgs]);
const built = join(run('/usr/bin/xcrun', ['swift', ...swiftArgs, '--show-bin-path']).trim(), 'localmost-vm');
if (!existsSync(built)) {
  fail(`swift build produced no ${built}`);
}

const stamp = `${sha256(built)} ${sha256(ENTITLEMENTS)}\n`;
if (existsSync(OUTPUT) && existsSync(STAMP) && readFileSync(STAMP, 'utf-8') === stamp) {
  console.log(`build:helper: ${OUTPUT} is up to date`);
  process.exit(0);
}

// Signed beside its final name and renamed into place, so that a failed
// signing never leaves an unsigned helper where the app looks for it.
const staging = `${OUTPUT}.tmp`;
rmSync(staging, { force: true });
copyFileSync(built, staging);
run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', ENTITLEMENTS, staging]);
renameSync(staging, OUTPUT);
writeFileSync(STAMP, stamp);
console.log(`build:helper: built and signed ${OUTPUT}`);
