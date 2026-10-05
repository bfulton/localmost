#!/usr/bin/env node
// Builds localmost-macvm, the helper that builds the golden macOS image and
// runs one macOS VM per macos-vm job, and localmost-macvm-agent, the agent
// the image's setup copies into the guest (docs/roadmap/macos-vm-jobs.md).
//
// Both are built for release on arm64 from native/localmost-macvm and copied
// to build/. The helper is ad-hoc signed there with the virtualization
// entitlement and nothing else, so that development runs can start VMs; the
// agent with none, since it runs in the guest. Those are the paths an
// unpackaged app finds them at (src/main/isolation/macos-vm/paths.ts) and the
// ones the packager copies into Resources; osx-sign re-signs both with the
// app's identity when there is one.
//
// Built with Xcode 27 (Swift 6.4) the helper includes macOS 27's guest
// provisioning, and says so in `localmost-macvm version`; with an older
// Xcode it leaves it out, and the app offers the guided setup instead.
//
// It is cached as build:helper is: SwiftPM rebuilds only what changed, and a
// binary is copied and signed again only when the build, its entitlements or
// the signing options changed, or the copy in build/ is no longer the one
// signed.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = join(ROOT, 'native', 'localmost-macvm');
const SCRATCH = join(ROOT, 'build', 'swift', 'localmost-macvm');

const PRODUCTS = [
  { name: 'localmost-macvm', entitlements: join(ROOT, 'packaging', 'entitlements.virtualization.plist') },
  { name: 'localmost-macvm-agent', entitlements: join(ROOT, 'packaging', 'entitlements.none.plist') },
];

function fail(message) {
  console.error(`build:macvm: ${message}`);
  process.exit(1);
}

function run(file, args) {
  return execFileSync(file, args, { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  fail('the macOS VM helper uses Virtualization.framework and builds only on Apple silicon macOS');
}
for (const { entitlements } of PRODUCTS) {
  if (!existsSync(entitlements)) fail(`${entitlements} is missing`);
}

const swiftArgs = ['build', '-c', 'release', '--arch', 'arm64', '--package-path', PACKAGE, '--scratch-path', SCRATCH];
run('/usr/bin/xcrun', ['swift', ...swiftArgs]);
const binPath = run('/usr/bin/xcrun', ['swift', ...swiftArgs, '--show-bin-path']).trim();

for (const { name, entitlements } of PRODUCTS) {
  const built = join(binPath, name);
  const output = join(ROOT, 'build', name);
  const stamp = `${output}.stamp`;
  if (!existsSync(built)) fail(`swift build produced no ${built}`);
  const signing = ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements];
  const inputs = { built: sha256(built), entitlements: sha256(entitlements), signing };
  let upToDate = false;
  if (existsSync(output) && existsSync(stamp)) {
    try {
      upToDate = readFileSync(stamp, 'utf-8') === `${JSON.stringify({ ...inputs, output: sha256(output) })}\n`;
    } catch {
      upToDate = false;
    }
  }
  if (upToDate) {
    console.log(`build:macvm: ${output} is up to date`);
    continue;
  }
  // Signed beside its final name and renamed into place, so that a failed
  // signing never leaves an unsigned binary where the app looks for it.
  const staging = `${output}.tmp`;
  rmSync(staging, { force: true });
  copyFileSync(built, staging);
  run('/usr/bin/codesign', [...signing, staging]);
  renameSync(staging, output);
  writeFileSync(stamp, `${JSON.stringify({ ...inputs, output: sha256(output) })}\n`);
  console.log(`build:macvm: built and signed ${output}`);
}
