/**
 * Session Persistence
 *
 * Handles persisting session IDs to disk for cleanup on restart.
 * This allows the broker proxy to clean up stale sessions from previous runs.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getRunnerDir } from '../paths';
import { getLogger } from '../app-state';

const log = () => getLogger();

/** Saved session IDs by target and instance */
export interface SavedSessionIds {
  [targetId: string]: {
    [instanceNum: number]: string;
  };
}

/**
 * Manages persistence of broker session IDs to disk.
 */
export class SessionPersistence {
  private filePath: string;

  constructor() {
    this.filePath = path.join(getRunnerDir(), 'broker-sessions.json');
  }

  /**
   * Load saved session IDs from disk.
   */
  load(): SavedSessionIds {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }
    } catch {
      log()?.debug('[SessionPersistence] Could not load saved sessions');
    }
    return {};
  }

  /**
   * Save a session ID to disk.
   */
  save(targetId: string, instanceNum: number, sessionId: string): void {
    const sessions = this.load();
    if (!sessions[targetId]) {
      sessions[targetId] = {};
    }
    sessions[targetId][instanceNum] = sessionId;
    try {
      this.writeWhole(JSON.stringify(sessions, null, 2));
    } catch (err) {
      log()?.debug(`[SessionPersistence] Could not save session: ${(err as Error).message}`);
    }
  }

  /**
   * Remove a session ID from disk (after successful deletion).
   */
  remove(targetId: string, instanceNum: number): void {
    const sessions = this.load();
    if (sessions[targetId]) {
      delete sessions[targetId][instanceNum];
      if (Object.keys(sessions[targetId]).length === 0) {
        delete sessions[targetId];
      }
    }
    try {
      if (Object.keys(sessions).length === 0) {
        fs.unlinkSync(this.filePath);
      } else {
        this.writeWhole(JSON.stringify(sessions, null, 2));
      }
    } catch {
      // Ignore errors - file may not exist
    }
  }

  /**
   * Replace the file whole or not at all. A write that died partway - a full
   * disk, a crash - left half a file, which load() cannot parse and reads as
   * no sessions, so those the last run left upstream were never cleaned up.
   * The rename within one directory is atomic; a failed write leaves the
   * previous file as it was.
   *
   * The temporary name is fixed rather than per-process: the app holds a
   * single-instance lock and writes synchronously, so nothing else writes it
   * at the same time, and a file a crash left behind is overwritten by the
   * next save instead of accumulating. It holds the same session ids, and one
   * known name is one the runner profile can read-deny beside the real file.
   *
   * The ids are live broker sessions, so the file is the user's alone (0600)
   * whatever the umask. The rename gives the real file the temporary file's
   * mode, so that is the one set, and set again on a file a crash left behind,
   * which opening for writing would not change.
   */
  private writeWhole(content: string): void {
    const temp = `${this.filePath}.tmp`;
    try {
      const fd = fs.openSync(temp, 'w', 0o600);
      try {
        fs.fchmodSync(fd, 0o600);
        fs.writeFileSync(fd, content);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, this.filePath);
    } catch (err) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // Never created, or already renamed into place
      }
      throw err;
    }
  }

  /**
   * Clear all saved session IDs from disk.
   */
  clear(): void {
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  /**
   * Get the count of saved sessions.
   */
  getSessionCount(): number {
    const sessions = this.load();
    return Object.values(sessions).reduce(
      (sum, targetSessions) => sum + Object.keys(targetSessions).length,
      0
    );
  }
}
