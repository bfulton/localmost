/**
 * A job's own directory in the per-user temp directory.
 *
 * Foundation finds its temp directory through the Darwin user directories,
 * not TMPDIR: NSTemporaryDirectory(), java.io.tmpdir, and the staging
 * directory a sandboxed process's atomic writes go through
 * (`T/TemporaryItems/NSIRD_*` - SwiftPM's and xcodebuild's manifests, plists
 * and caches among them). The per-user temp directory `T` is shared with
 * everything the user runs, so the sandbox grants none of it, and those
 * writes failed with "You don't have permission" at every level.
 *
 * With DIRHELPER_USER_DIR_SUFFIX=<name> in its environment, a process's
 * Darwin user directories move to `T/<name>/`. Each job gets a name of its
 * own, the app makes `T/<name>` before the job and removes it after, and
 * the job's profile grants that directory alone. The app makes it, rather
 * than leaving it to the system: one the system makes for a process is
 * marked so that nothing but the system can remove it.
 */

import { execFileSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { REMOVAL_PREFIX, removeMovedAside } from '../shared/tree-removal';

/** A sandbox's directory name: the slot, and the random id buildSandbox gave it. */
const SANDBOX_NAME = /^\d+-[0-9a-f]{12}$/;

/** A job temp directory's name: localmost's, its data directory's, and its sandbox's. */
const JOB_TEMP_NAME = /^localmost-[0-9a-f]{8}-\d+-[0-9a-f]{12}$/;

/**
 * The per-user temp directory confstr hands out, once a lookup has answered.
 * A failed lookup is not remembered: it is tried again at the next spawn, so
 * one transient failure does not cost every later job.
 */
let userTempDirFound: string | undefined;
/** Whether a failed lookup has been logged, so a lasting failure logs once. */
let userTempDirFailureLogged = false;

/**
 * The per-user temp directory, `/var/folders/<a>/<b>/T`, as getconf
 * DARWIN_USER_TEMP_DIR answers it for this process, without /private. Only
 * a path of that shape is accepted: it lands in the profile, and it is the
 * one directory a job temp directory is ever made or removed in.
 */
export function userTempDir(onLog?: (level: 'error', message: string) => void): string | undefined {
  if (userTempDirFound !== undefined) return userTempDirFound;
  let failure: string;
  try {
    const answer = String(execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf-8' }))
      .trim()
      .replace(/\/+$/, '')
      .replace(/^\/private/, '');
    if (/^\/var\/folders\/[A-Za-z0-9_+-]+\/[A-Za-z0-9_+-]+\/T$/.test(answer)) {
      userTempDirFound = answer;
      return userTempDirFound;
    }
    failure = `unexpected answer ${JSON.stringify(answer)}`;
  } catch (err) {
    failure = (err as Error).message;
  }
  if (!userTempDirFailureLogged && onLog) {
    userTempDirFailureLogged = true;
    onLog('error', `Per-user temp directory lookup failed, so jobs cannot use mktemp without a template, nor have a temp directory of their own there: ${failure}`);
  }
  return undefined;
}

/**
 * The name of a sandbox's job temp directory, and its job's
 * DIRHELPER_USER_DIR_SUFFIX: `localmost-<data>-<sandbox id>`. `<data>` is
 * taken from the sandbox directory's parent, so the jobs of another data
 * directory - a development build beside the installed app - are named
 * apart and neither app's sweep takes the other's. The sandbox id carries
 * the 48 random bits buildSandbox gave it, so a job cannot guess another's.
 */
export function jobTempName(sandboxDir: string): string {
  const id = path.basename(sandboxDir);
  if (path.resolve(sandboxDir) !== sandboxDir || !SANDBOX_NAME.test(id)) {
    throw new Error(`${sandboxDir} is not a sandbox, so it has no job temp directory`);
  }
  return `localmost-${dataTag(path.dirname(sandboxDir))}-${id}`;
}

/** Eight hex characters naming a sandbox base, the same for every sandbox in it. */
function dataTag(sandboxBase: string): string {
  return createHash('sha256').update(sandboxBase).digest('hex').slice(0, 8);
}

/**
 * Whether `dir` is a job temp directory directly in `userTemp`: exactly
 * `<userTemp>/<a job temp name>`, spelled with no `..`, `.` or trailing
 * slash, in a directory named T. Every removal asks this first.
 */
export function isJobTempDir(userTemp: string, dir: string): boolean {
  return (
    path.isAbsolute(userTemp) &&
    path.resolve(userTemp) === userTemp &&
    path.basename(userTemp) === 'T' &&
    path.resolve(dir) === dir &&
    path.dirname(dir) === userTemp &&
    JOB_TEMP_NAME.test(path.basename(dir))
  );
}

/** Throw unless `dir` is a job temp directory in `userTemp` (see isJobTempDir). */
export function assertJobTempDir(userTemp: string, dir: string): void {
  if (!isJobTempDir(userTemp, dir)) {
    throw new Error(`Refusing to remove ${dir}: not a job temp directory in ${userTemp}`);
  }
}

/**
 * Make a sandbox's job temp directory in `userTemp`, 0700, and return it.
 * A plain mkdir, which refuses a name that is already there - a link
 * included - so one is never taken over.
 */
export function createJobTempDir(userTemp: string, sandboxDir: string): string {
  const dir = path.join(userTemp, jobTempName(sandboxDir));
  if (!isJobTempDir(userTemp, dir)) throw new Error(`${userTemp} is not a per-user temp directory`);
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/**
 * Remove a job temp directory and what its job left in it. Refuses any
 * other path: this deletes a whole tree, in a directory every process the
 * user runs keeps things in.
 *
 * Moved out of the per-user temp directory first, into `asideBase` - the
 * sandbox base, on the same volume, which only the app writes - and removed
 * there without following a link (see removeMovedAside). Not removed where it
 * is: macOS protects any TemporaryItems directory in the per-user temp
 * directory by its path, so the staging directory a job's atomic writes left
 * there cannot be removed by anything but the system - and moved out, it can.
 * Moved, it is also out of reach of anything of the job still running,
 * whose profile granted its old path. One left in the base by a failed
 * removal goes with the next startup's sweep of the sandbox base.
 */
export async function removeJobTempDir(userTemp: string, dir: string, asideBase: string): Promise<void> {
  assertJobTempDir(userTemp, dir);
  const aside = path.join(asideBase, `${REMOVAL_PREFIX}${path.basename(dir)}.${randomBytes(4).toString('hex')}`);
  try {
    await fs.promises.rename(dir, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  await removeMovedAside(aside);
}

/**
 * At startup, remove the job temp directories this data directory's
 * finished jobs left - the app quit before it removed them, or could not.
 * One whose sandbox is still there is kept, as its sandbox is: something
 * of its job may still be running. Nothing in `userTemp` but this data
 * directory's job temp directories is touched.
 */
export async function sweepJobTempDirs(
  userTemp: string,
  sandboxBase: string,
  log: (message: string) => void
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(userTemp);
  } catch {
    return;
  }
  const ours = `localmost-${dataTag(sandboxBase)}-`;
  for (const name of entries) {
    if (!name.startsWith(ours) || !JOB_TEMP_NAME.test(name)) continue;
    if (fs.existsSync(path.join(sandboxBase, name.slice(ours.length)))) continue;
    const dir = path.join(userTemp, name);
    try {
      await removeJobTempDir(userTemp, dir, sandboxBase);
      log(`Removed a finished job's temp directory: ${name}`);
    } catch (err) {
      log(`Could not remove a finished job's temp directory ${name}: ${(err as Error).message}`);
    }
  }
}
