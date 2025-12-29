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
      fs.writeFileSync(this.filePath, JSON.stringify(sessions, null, 2));
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
        fs.writeFileSync(this.filePath, JSON.stringify(sessions, null, 2));
      }
    } catch {
      // Ignore errors - file may not exist
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
