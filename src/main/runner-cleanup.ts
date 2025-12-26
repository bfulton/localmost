/**
 * Runner cleanup utilities for managing stale sandboxes, configs, and work directories.
 * Extracted from runner-downloader.ts for better separation of concerns.
 */

import * as fs from 'fs';
import * as path from 'path';
import { shell } from 'electron';

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
 * Kill orphaned runner processes found in sandbox directories.
 * Must be called BEFORE deleting sandbox directories since PID files are inside them.
 */
export async function killOrphanedProcesses(
  sandboxBase: string,
  log: CleanupLogger
): Promise<boolean> {
  let killedAny = false;

  try {
    const entries = await fs.promises.readdir(sandboxBase, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.includes('.trash.')) continue;

      const pidFile = path.join(sandboxBase, entry.name, 'runner.pid');
      if (!fs.existsSync(pidFile)) continue;

      try {
        const pidStr = await fs.promises.readFile(pidFile, 'utf-8');
        const pid = parseInt(pidStr.trim(), 10);
        if (isNaN(pid)) continue;

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
