/**
 * Runner cleanup utilities for managing stale sandboxes, configs, and work directories.
 * Extracted from runner-downloader.ts for better separation of concerns.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, execFileSync, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import { shell } from 'electron';

const execFileAsync = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type CleanupLogger = (message: string) => void;
export type LeveledLogger = (level: 'info' | 'error', message: string) => void;

/**
 * Validate that a child path stays within the expected base directory.
 * Prevents path traversal attacks via malicious directory names.
 * @returns The validated path, or null if it escapes the base.
 */
export function validateChildPath(base: string, childName: string): string | null {
  // Reject names with path separators or traversal sequences
  if (childName.includes('/') || childName.includes('\\') || childName.includes('..')) {
    return null;
  }
  const childPath = path.join(base, childName);
  const normalizedChild = path.normalize(childPath);
  const normalizedBase = path.normalize(base);
  // Ensure the resolved path is within the base directory
  if (!normalizedChild.startsWith(normalizedBase + path.sep) && normalizedChild !== normalizedBase) {
    return null;
  }
  return normalizedChild;
}

/**
 * The OS-reported start time of a process, or null if it is not running.
 *
 * A pid alone cannot be trusted after a crash: the OS can reuse it for an
 * unrelated process before a sweep runs. Recording the start time at spawn and
 * comparing it here tells a still-living worker from a stranger that inherited
 * its pid, so a sweep never signals the wrong process.
 */
export function processStartTime(pid: number): string | null {
  try {
    const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null; // no such process
  }
}

const LSOF = '/usr/sbin/lsof';
const LSOF_TIMEOUT_MS = 10_000;

/** The pids in `lsof -t` output, minus the ones no sweep may ever signal. */
function parseLsofPids(out: string): number[] {
  const pids = new Set<number>();
  for (const token of out.split(/\s+/)) {
    if (!/^\d+$/.test(token)) continue;
    const pid = Number(token);
    if (pid > 1 && pid !== process.pid) pids.add(pid);
  }
  return [...pids];
}

/**
 * What a failed lsof run means. The shapes are child_process.execFile's: a
 * numeric `code` for a nonzero exit, a string `code` for a spawn failure,
 * `killed`/`signal` for a timeout.
 *
 * A run that did not finish cannot vouch for what it did not print, so it is
 * unknown (null) even with partial output. A finished run's output is the
 * holders it found. Exit 1 with nothing on either stream is lsof's "nobody
 * holds it"; with -w in force, anything on stderr is an error, not a warning,
 * and any other status is unknown.
 */
export function classifyLsofFailure(err: unknown): number[] | null {
  const e = err as {
    code?: number | string | null; killed?: boolean; signal?: string | null;
    stdout?: string | Buffer; stderr?: string | Buffer;
  };
  if (e.killed || e.signal || typeof e.code === 'string' || typeof e.code !== 'number') return null;
  const stdout = String(e.stdout ?? '').trim();
  const stderr = String(e.stderr ?? '').trim();
  // With -w in force, stderr text is an error: some process could not be
  // examined, so whatever was listed is not the whole answer.
  if (stderr !== '') return null;
  if (stdout !== '') return parseLsofPids(stdout);
  return e.code === 1 ? [] : null;
}

async function runLsof(file: string): Promise<number[] | null> {
  try {
    // -n -P: no name lookups; -w: no warnings; -t: pids only.
    const { stdout } = await execFileAsync(LSOF, ['-n', '-P', '-w', '-t', '--', file], {
      encoding: 'utf-8',
      timeout: LSOF_TIMEOUT_MS,
    });
    return parseLsofPids(stdout);
  } catch (err) {
    // Removed between the caller's existence check and this run: lsof
    // reports a status error on stderr, which would otherwise read as unknown.
    if (!fs.existsSync(file)) return [];
    return classifyLsofFailure(err);
  }
}

/** Have a child hold a probe file open and ask lsof who holds it. */
async function probeLsofVisibility(): Promise<boolean> {
  const probe = path.join(os.tmpdir(), `localmost-lsof-probe-${process.pid}-${randomBytes(4).toString('hex')}`);
  let fd: number | undefined;
  let child: ChildProcess | undefined;
  try {
    fs.writeFileSync(probe, '');
    fd = fs.openSync(probe, 'r');
    child = spawn('/bin/sleep', ['30'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    child.on('error', () => undefined);
    fs.closeSync(fd);
    fd = undefined;
    if (child.pid === undefined) return false;
    const holders = await runLsof(probe);
    return holders !== null && holders.includes(child.pid);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* closed */ }
    }
    try { child?.kill('SIGKILL'); } catch { /* gone */ }
    try { fs.unlinkSync(probe); } catch { /* gone */ }
  }
}

let lsofTrusted: Promise<boolean> | undefined;

/**
 * Whether lsof here can see what other processes hold open. An lsof that
 * cannot examine other processes answers "nobody" for everything - exit 1,
 * no output, the same as a marker nobody holds - so until the probe has
 * passed, every marker answer is unknown and every marker is kept. Only a
 * pass is remembered: a probe that failed under load, or because spawn was
 * refused, must not blind every sweep until the app restarts.
 */
export function lsofCanSeeOtherProcesses(probe: () => Promise<boolean> = probeLsofVisibility): Promise<boolean> {
  if (!lsofTrusted) {
    const attempt: Promise<boolean> = probe().then(
      (ok) => {
        if (!ok && lsofTrusted === attempt) lsofTrusted = undefined;
        return ok;
      },
      () => {
        if (lsofTrusted === attempt) lsofTrusted = undefined;
        return false;
      }
    );
    lsofTrusted = attempt;
  }
  return lsofTrusted;
}

let blindnessLogged = false;

/**
 * The pids currently holding a per-spawn marker file open: [] if none, or
 * null if that could not be determined - which callers must treat as
 * "unknown" and keep the marker for a later sweep, never as "nobody".
 *
 * Every worker is started with an open descriptor on a marker file unique to
 * that spawn, passed as an extra inherited fd. Processes launched through the
 * bash and .NET layers of the runner (run.sh, Runner.Listener, Runner.Worker,
 * `run:` step shells and what they exec, the docker CLI) inherit it and hold
 * it for as long as they live - even after the worker leader has exited and
 * they have been reparented. `lsof` on the marker therefore names those
 * survivors exactly, which a pid or pgid cannot once the leader is gone: a
 * recycled pid would have to actually hold this specific inherited fd.
 *
 * Coverage limit: children spawned by Node (JS actions via libuv) or Python
 * (subprocess) do not inherit it - both close inherited fds on spawn - so
 * their grandchildren are reached only through the process-group path while
 * the leader lives. The marker is a large improvement over pgid-only reaping,
 * not full-tree coverage.
 */
export async function markerHolders(
  markerPath: string,
  log?: CleanupLogger,
  trusted: () => Promise<boolean> = lsofCanSeeOtherProcesses
): Promise<number[] | null> {
  if (!fs.existsSync(markerPath)) return [];
  if (!(await trusted())) {
    if (!blindnessLogged) {
      blindnessLogged = true;
      log?.("lsof cannot see other processes' open files here; marker files are kept, not swept");
    }
    return null;
  }
  return runLsof(markerPath);
}

export interface OrphanSignalResult {
  /** Whether anything was signalled at all. */
  signalled: boolean;
  /**
   * Who still holds the marker afterwards: [] means the marker may be
   * released; null means that could not be determined, so it must be kept.
   */
  remaining: number[] | null;
}

/**
 * Terminate the holders of a marker: SIGTERM each, wait out the grace period,
 * then SIGKILL whatever holds the marker at that point - not the original
 * list, which kill(pid, 0) cannot tell from strangers that inherited freed
 * pids during the grace period, and which misses a holder's fork. An unknown
 * answer at either look means no SIGKILL and a kept marker: the next sweep
 * starts over with the same reuse-proof handle.
 */
export async function signalOrphanPids(
  pids: number[],
  log: CleanupLogger,
  graceMs: number,
  stillHeld: () => Promise<number[] | null> | number[] | null
): Promise<OrphanSignalResult> {
  const signalable = (list: number[]): number[] => list.filter((pid) => pid > 1 && pid !== process.pid);
  const targets = signalable(pids);
  if (targets.length === 0) return { signalled: false, remaining: [] };
  log(`Killing orphaned runner processes ${targets.join(', ')}`);
  for (const pid of targets) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await sleep(graceMs);
  const held = await stillHeld();
  if (held === null) {
    log('Could not re-check which orphans remain; keeping their marker for the next sweep');
    return { signalled: true, remaining: null };
  }
  const toKill = signalable(held);
  if (toKill.length === 0) return { signalled: true, remaining: [] };
  for (const pid of toKill) {
    log(`Force killing orphaned process ${pid}`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* exited meanwhile */ }
  }
  // SIGKILL cannot be refused, but teardown is not instant; look once more
  // before calling the marker free.
  await sleep(Math.min(graceMs, 500));
  const remaining = await stillHeld();
  if (remaining === null) {
    log('Could not confirm the orphans are gone; keeping their marker for the next sweep');
  } else if (remaining.length > 0) {
    log(`Orphans ${remaining.join(', ')} still hold their marker after SIGKILL; keeping it for the next sweep`);
  }
  return { signalled: true, remaining };
}

/**
 * Parse a pid record: line one is "<pid> <start time>", line two (optional) is
 * the spawn's marker file path.
 */
export function parsePidRecord(raw: string): { pid: number | null; recordedStart: string; markerPath: string | null } {
  const lines = raw.split('\n');
  const first = (lines[0] ?? '').trim();
  const sep = first.search(/\s/);
  const pidStr = sep === -1 ? first : first.slice(0, sep);
  const recordedStart = sep === -1 ? '' : first.slice(sep + 1).trim();
  const markerPath = (lines[1] ?? '').trim() || null;
  if (!/^\d+$/.test(pidStr)) return { pid: null, recordedStart, markerPath };
  const pid = Number(pidStr);
  return { pid: Number.isSafeInteger(pid) ? pid : null, recordedStart, markerPath };
}

/**
 * Kill orphaned runner processes recorded by a previous run.
 *
 * Reads the app-owned pid directory (a sibling of the sandbox base), never a
 * pid file inside a sandbox: the sandbox is writable by the job, so a pid file
 * there is attacker-controlled and a job could make this signal any process.
 * The app writes each worker's pid to `<runner>/pids/<instance>.pid`.
 */
export async function killOrphanedProcesses(
  sandboxBase: string,
  log: CleanupLogger,
  startTimeOf: (pid: number) => string | null = processStartTime,
  holdersOf: (markerPath: string) => Promise<number[] | null> | number[] | null = (p) => markerHolders(p, log)
): Promise<boolean> {
  let killedAny = false;
  const pidDir = path.join(path.dirname(sandboxBase), 'pids');

  try {
    if (!fs.existsSync(pidDir)) return false;
    const entries = await fs.promises.readdir(pidDir, { withFileTypes: true });

    // Markers first. A marker names the surviving holders of one spawn's
    // descriptor, leader or not, so this reaps a leaderless orphan group that
    // the pid/start-time path below cannot verify. A marker left
    // behind here means the app did not finalize that worker (it crashed), so
    // every one is checked and then removed.
    for (const entry of entries) {
      if (entry.isDirectory() || !/^\d+-[0-9a-f]+\.mark$/.test(entry.name)) continue;
      const markerPath = path.join(pidDir, entry.name);
      const holders = await holdersOf(markerPath);
      if (holders === null) {
        // Unknown is not "nobody". The marker is the only reuse-proof handle
        // on those survivors; keep it and let the next sweep try again.
        log(`Could not check who holds ${entry.name}; keeping it for the next sweep`);
        continue;
      }
      let remaining: number[] | null = holders;
      if (holders.length > 0) {
        const result = await signalOrphanPids(holders, log, 2000, () => holdersOf(markerPath));
        killedAny = result.signalled || killedAny;
        remaining = result.remaining;
      }
      // Only a marker nobody holds is safe to drop; signalOrphanPids has said
      // why any other is being kept.
      if (remaining !== null && remaining.length === 0) {
        await fs.promises.unlink(markerPath).catch(() => undefined);
      }
    }

    for (const entry of entries) {
      if (entry.isDirectory() || !/^\d+\.pid$/.test(entry.name)) continue;

      const pidFile = path.join(pidDir, entry.name);
      if (!fs.existsSync(pidFile)) continue;

      try {
        const raw = await fs.promises.readFile(pidFile, 'utf-8');
        // Line one is "<pid> <start time>". The pid must be digits only
        // (parseInt would take '1234junk' as 1234), a safe integer, above 1
        // (kill(-1) signals every process the user owns, kill(0) the whole
        // group), and not this process.
        const { pid, recordedStart } = parsePidRecord(raw);
        if (pid === null || pid <= 1 || pid === process.pid) continue;
        // Only signal a process whose start time still matches what was recorded
        // at spawn. A missing record or a mismatch means the pid was reused (or
        // predates this format); either way it is not our worker, so leave it.
        if (recordedStart === '' || startTimeOf(pid) !== recordedStart) {
          await fs.promises.unlink(pidFile).catch(() => undefined);
          continue;
        }

        // Check if process is running and kill it
        try {
          process.kill(pid, 0); // Check if alive
          log(`Killing orphaned runner process group ${pid}`);
          killedAny = true;
          try {
            process.kill(-pid, 'SIGTERM'); // Kill process group
          } catch {
            // Process group kill failed (not a group leader?) - fall back to single process
            process.kill(pid, 'SIGTERM');
          }
          // Give it time to gracefully disconnect from GitHub
          await new Promise(resolve => setTimeout(resolve, 2000));
          // Force kill if still alive
          try {
            process.kill(pid, 0);
            log(`Force killing orphaned process ${pid}`);
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              // Process group kill failed - fall back to single process
              process.kill(pid, 'SIGKILL');
            }
          } catch {
            // Process exited after SIGTERM - this is the expected success case
          }
        } catch {
          // Process not running (ESRCH) - already dead, nothing to do
        }
        await fs.promises.unlink(pidFile).catch(() => undefined);
      } catch {
        // Couldn't read PID file - corrupted or permissions issue, skip
      }
    }
  } catch {
    // Failed to scan sandbox directories - non-fatal, continue with cleanup
  }

  return killedAny;
}

/**
 * Clean up sandbox directories (both regular and trash directories).
 */
export async function cleanupSandboxDirectories(
  sandboxBase: string,
  log: CleanupLogger
): Promise<void> {
  try {
    const entries = await fs.promises.readdir(sandboxBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Security: Validate path stays within sandbox base
      const dirPath = validateChildPath(sandboxBase, entry.name);
      if (!dirPath) {
        log(`Warning: Skipping suspicious directory name: ${entry.name}`);
        continue;
      }

      if (entry.name.includes('.trash.')) {
        // Trash directories: try to remove (may have extended attributes blocking deletion)
        try {
          await fs.promises.rm(dirPath, { recursive: true, force: true });
          log(`Removed leftover trash: ${entry.name}`);
        } catch {
          // fs.rm failed (likely due to macOS extended attributes on .app bundles)
          // Fall back to moving to system Trash
          try {
            await shell.trashItem(dirPath);
            log(`Moved to Trash: ${entry.name}`);
          } catch (trashErr) {
            log(`Warning: Failed to remove trash ${entry.name}: ${(trashErr as Error).message}`);
          }
        }
      } else {
        // Regular sandbox directories: clean synchronously with timeout
        log(`Removing sandbox: ${entry.name}`);
        try {
          const timeoutMs = 5000; // 5 seconds per directory
          const rmPromise = fs.promises.rm(dirPath, { recursive: true, force: true });
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), timeoutMs)
          );
          await Promise.race([rmPromise, timeoutPromise]);
        } catch {
          // Deletion failed or timed out - rename to trash for background cleanup
          const trashDir = `${dirPath}.trash.${Date.now()}`;
          try {
            await fs.promises.rename(dirPath, trashDir);
            log(`Moved ${entry.name} to trash for background cleanup`);
            fs.promises.rm(trashDir, { recursive: true, force: true }).catch(() => {
              // Background cleanup failure is non-fatal
            });
          } catch {
            log(`Warning: Could not clean ${entry.name}, will retry when runner starts`);
          }
        }
      }
    }
  } catch {
    // Failed to read sandbox directory - non-fatal, skip cleanup
  }
}

/**
 * Clean up incomplete config directories (missing .runner file).
 */
export async function cleanupIncompleteConfigs(
  configBase: string,
  log: CleanupLogger
): Promise<void> {
  if (!fs.existsSync(configBase)) return;

  const entries = await fs.promises.readdir(configBase, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Security: Validate path stays within config base
    const configDir = validateChildPath(configBase, entry.name);
    if (!configDir) {
      log(`Warning: Skipping suspicious config directory name: ${entry.name}`);
      continue;
    }

    const runnerFile = path.join(configDir, '.runner');

    if (!fs.existsSync(runnerFile)) {
      log(`Removing incomplete config directory: ${entry.name}`);
      try {
        await fs.promises.rm(configDir, { recursive: true, force: true });
      } catch {
        // Config cleanup failed - non-fatal, may succeed on next startup
        log(`Warning: Failed to remove config directory ${entry.name}`);
      }
    }
  }
}

/**
 * Clean up work directories using rename + background delete for speed.
 */
export async function cleanupWorkDirectories(
  workBase: string,
  log: CleanupLogger
): Promise<void> {
  if (!fs.existsSync(workBase)) return;

  log('Cleaning up work directories...');
  try {
    const entries = await fs.promises.readdir(workBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Security: Validate path stays within work base
      const workDir = validateChildPath(workBase, entry.name);
      if (!workDir) {
        log(`Warning: Skipping suspicious work directory name: ${entry.name}`);
        continue;
      }

      log(`Removing work directory: ${entry.name}`);

      // Use rename + background delete for speed (work dirs can be large)
      const trashDir = `${workDir}.trash.${Date.now()}`;
      try {
        fs.renameSync(workDir, trashDir);
        fs.promises.rm(trashDir, { recursive: true, force: true }).catch(() => {
          // Background cleanup failure is non-fatal
        });
      } catch {
        // Rename failed (cross-device?) - try direct delete as fallback
        fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {
          // Work dir cleanup failed - non-fatal, will try again next time
        });
      }
    }
  } catch {
    // Failed to scan work directories - non-fatal
  }
}

/**
 * Move a directory to trash for background cleanup.
 * Returns true if successful, false if rename failed.
 */
export function moveToTrash(dirPath: string, log: CleanupLogger): boolean {
  const trashDir = `${dirPath}.trash.${Date.now()}`;
  try {
    fs.renameSync(dirPath, trashDir);
    log(`Moved to trash for background cleanup`);
    // Delete in background (fire and forget)
    fs.promises.rm(trashDir, { recursive: true, force: true }).catch(() => {
      // Background cleanup - failures are non-fatal, will retry on next startup
    });
    return true;
  } catch {
    return false;
  }
}
