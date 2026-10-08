/**
 * Runner cleanup utilities for managing stale sandboxes, configs, and work directories.
 * Extracted from runner-downloader.ts for better separation of concerns.
 */

import * as fs from 'fs';
import * as path from 'path';
import { shell } from 'electron';
import { REMOVAL_PREFIX, moveAsideForRemoval, removeMovedAside } from '../shared/tree-removal';

// Shared with the CLI, which removes a test workspace the same way.
export { REMOVAL_PREFIX, moveAsideForRemoval, removeMovedAside };

export type CleanupLogger = (message: string) => void;

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
 * Clean up sandbox directories: each is moved out of its path and removed
 * (see moveAsideForRemoval and removeMovedAside), and what an earlier run
 * left part removed goes too.
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

      // Already out of every job's reach: a removal an earlier run began, or
      // trash an earlier version's sweep moved aside.
      if (entry.name.startsWith(REMOVAL_PREFIX) || entry.name.includes('.trash.')) {
        // Removed where they are (may have extended attributes blocking deletion)
        try {
          await removeMovedAside(dirPath);
          log(`Removed leftover ${entry.name}`);
        } catch {
          // Removal failed (likely due to macOS extended attributes on .app bundles)
          // Fall back to moving to system Trash
          try {
            await shell.trashItem(dirPath);
            log(`Moved to Trash: ${entry.name}`);
          } catch (trashErr) {
            log(`Warning: Failed to remove trash ${entry.name}: ${(trashErr as Error).message}`);
          }
        }
      } else {
        // Regular sandbox directories: moved out of their path, never removed
        // in it, then removed with a timeout
        log(`Removing sandbox: ${entry.name}`);
        let aside: string | null;
        try {
          aside = await moveAsideForRemoval(dirPath);
        } catch {
          log(`Warning: Could not move ${entry.name} aside to remove it; it stays until the next launch`);
          continue;
        }
        if (!aside) continue;
        const timeoutMs = 5000; // 5 seconds per directory
        let timer: NodeJS.Timeout | undefined;
        const rmPromise = removeMovedAside(aside);
        try {
          await Promise.race([
            rmPromise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
            }),
          ]);
        } catch {
          // Deletion failed or timed out: one still going finishes in the
          // background, and what is left goes at the next startup
          rmPromise.catch(() => {
            // Background cleanup failure is non-fatal
          });
          log(`Could not finish removing ${entry.name} yet; the rest goes in the background or at the next startup`);
        } finally {
          clearTimeout(timer);
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
