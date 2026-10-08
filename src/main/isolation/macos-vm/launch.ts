/**
 * The real helper launch: each command's seatbelt profile written to
 * `<data>/macos-vm/profiles/` (0700, closed to jobs as all of `<data>` is),
 * the helper spawned under it through sandbox-exec with PATH and TMPDIR
 * alone, and the profile removed when the helper exits. Also the runner's
 * archive, packed once per version for the guest.
 */

import { execFile, execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as tar from 'tar';
import { buildMacVmProfile, type MacVmProfileOptions } from './helper-profile';
import { MacVmHelper, sandboxedMacVmSpawn, type HelperInvocation } from './helper-client';
import { imageDir, macVmLayout, macVmHelperPath, vmDir } from './paths';

/** DARWIN_USER_CACHE_DIR, realpathed: where Metal keeps the VM display's shader cache. */
export function userCacheDir(): string {
  return fs.realpathSync(execFileSync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf-8', timeout: 5000 }).trim());
}

/** The profile options for an invocation: the paths its command touches, and nothing else. */
export function profileOptions(inv: HelperInvocation, helper: string, dataDir: string, cacheDir: string, window = false): MacVmProfileOptions {
  const base = { helper, dataDir };
  switch (inv.command) {
    case 'catalog':
      return { command: 'catalog', ...base };
    case 'inspect':
      return { command: 'inspect', ...base, ipswName: path.basename(inv.ipsw) };
    case 'install':
      return { command: 'install', ...base, imageId: inv.imageId, ipswName: path.basename(inv.ipsw), slot: inv.slot, userCacheDir: cacheDir };
    case 'provision':
      return { command: 'provision', ...base, imageId: inv.imageId, slot: inv.slot, window, userCacheDir: cacheDir };
    case 'save-state':
      return { command: 'save-state', ...base, imageId: inv.imageId, slot: inv.slot, userCacheDir: cacheDir };
    case 'run':
      return { command: 'run', ...base, imageId: inv.imageId, vmId: inv.vmId, proxyPort: inv.proxyPort, brokerPort: inv.brokerPort, userCacheDir: cacheDir };
    case 'check':
      return { command: 'check', ...base, imageId: inv.imageId };
  }
}

/** TMPDIR for a command: a directory its profile grants, where one does. */
function tmpdirFor(inv: HelperInvocation, dataDir: string): string {
  switch (inv.command) {
    case 'install':
    case 'provision':
    case 'save-state':
      return imageDir(dataDir, inv.imageId);
    case 'run':
      return vmDir(dataDir, inv.vmId);
    default:
      return path.join(macVmLayout(dataDir).root, 'profiles');
  }
}

export function launcher(dataDir: string, log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void) {
  return (invocation: HelperInvocation, opts: { window?: boolean; expectAgentSocket?: string } = {}): MacVmHelper => {
    const helper = macVmHelperPath();
    const profiles = path.join(macVmLayout(dataDir).root, 'profiles');
    fs.mkdirSync(profiles, { recursive: true, mode: 0o700 });
    const profile = path.join(profiles, `${invocation.command}-${crypto.randomBytes(6).toString('hex')}.sb`);
    const needsCache = !['catalog', 'inspect', 'check'].includes(invocation.command);
    const text = buildMacVmProfile(profileOptions(invocation, helper, dataDir, needsCache ? userCacheDir() : '', opts.window));
    fs.writeFileSync(profile, text, { mode: 0o600, flag: 'wx' });
    const tmp = tmpdirFor(invocation, dataDir);
    const h = new MacVmHelper({
      helper,
      invocation,
      spawn: sandboxedMacVmSpawn(profile, tmp),
      env: { PATH: '/usr/bin:/bin', TMPDIR: tmp },
      log: (level, message) => log(level, `macOS VM helper (${invocation.command}): ${message}`),
      ...(opts.expectAgentSocket ? { expectAgentSocket: opts.expectAgentSocket } : {}),
    });
    h.once('exit', () => fs.rmSync(profile, { force: true }));
    return h;
  };
}

/** The helper's `version`: whether it was built with macOS 27's guest provisioning. */
export function helperHasProvisioning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(macVmHelperPath(), ['version'], { timeout: 10_000, env: { PATH: '/usr/bin:/bin' } }, (err, stdout) => {
      if (err) return resolve(false);
      try {
        resolve((JSON.parse(String(stdout)) as { provisioning?: unknown }).provisioning === true);
      } catch {
        resolve(false);
      }
    });
  });
}

/** Packs a runner directory as a gzipped tarball at `dest`, its entries relative and portable. */
export async function packRunner(dir: string, dest: string): Promise<void> {
  const tmp = `${dest}.tmp`;
  fs.rmSync(tmp, { force: true });
  await tar.c({ gzip: true, cwd: dir, file: tmp, portable: true }, ['.']);
  fs.renameSync(tmp, dest);
}

/** How the host's runner of a version is packed for a guest, and checked as it is sent. */
export interface RunnerPacking {
  /** Packs the runner, from a copy checked against its integrity record, as a gzipped tarball at `dest`. */
  pack(version: string, dest: string): Promise<void>;
  /** Throws unless `bytes` hold exactly what the version's integrity record does. */
  verify(version: string, bytes: Buffer): Promise<void>;
}

/**
 * Packs the runner of `version` at `dest` as `packing` does, and keeps it
 * only if its bytes check against the integrity record: the golden image's
 * build puts the runner into the image this way, as a job's send does.
 */
export async function packVerifiedRunner(packing: RunnerPacking, version: string, dest: string): Promise<void> {
  await packing.pack(version, dest);
  try {
    await packing.verify(version, fs.readFileSync(dest));
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  }
}

/**
 * The runner archive the guest is sent when it lacks the host's version:
 * packed once into `<data>/macos-vm/runner/<version>.tar.gz` and read back,
 * and checked against the runner's integrity record each time, from the
 * bytes that are sent: the file is kept between jobs, and one changed in
 * the meantime is packed again rather than sent.
 */
export async function runnerArchive(dataDir: string, version: string, packing: RunnerPacking): Promise<{ bytes: Buffer; sha256: string }> {
  if (!/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/.test(version)) throw new Error(`not a runner version: ${JSON.stringify(version)}`);
  const dir = path.join(macVmLayout(dataDir).root, 'runner');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${version}.tar.gz`);
  if (!fs.existsSync(file)) await packing.pack(version, file);
  let bytes = fs.readFileSync(file);
  try {
    await packing.verify(version, bytes);
  } catch {
    fs.rmSync(file, { force: true });
    await packing.pack(version, file);
    bytes = fs.readFileSync(file);
    await packing.verify(version, bytes);
  }
  return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
