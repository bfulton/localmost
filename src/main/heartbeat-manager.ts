/**
 * HeartbeatManager - Manages a GitHub Actions variable that serves as a heartbeat
 * to indicate that the localmost runner is online and available.
 *
 * Instead of requiring a token and API permissions to check runner status,
 * workflows can simply read the LOCALMOST_HEARTBEAT variable and check if
 * the timestamp is recent (less than ~90 seconds old).
 */

import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_VARIABLE_NAME } from '../shared/constants';

/** Configuration for the target repo or org */
export interface HeartbeatTarget {
  level: 'repo' | 'org';
  owner?: string;  // For repo level
  repo?: string;   // For repo level
  org?: string;    // For org level
}

export class HeartbeatManager {
  private intervalId: NodeJS.Timeout | null = null;
  private target: HeartbeatTarget | null = null;
  private runnerName: string | null = null;
  private onLog?: (level: 'info' | 'error' | 'warn', message: string) => void;

  // Callbacks for GitHub API operations (injected from main process)
  private setRepoVariable?: (owner: string, repo: string, name: string, value: string) => Promise<void>;
  private setOrgVariable?: (org: string, name: string, value: string) => Promise<void>;

  constructor(options?: {
    onLog?: (level: 'info' | 'error' | 'warn', message: string) => void;
  }) {
    this.onLog = options?.onLog;
  }

  /**
   * Set the runner name for logging purposes.
   */
  setRunnerName(name: string): void {
    this.runnerName = name;
  }

  /**
   * Set the callbacks for GitHub API operations.
   */
  setApiCallbacks(callbacks: {
    setRepoVariable: (owner: string, repo: string, name: string, value: string) => Promise<void>;
    setOrgVariable: (org: string, name: string, value: string) => Promise<void>;
  }): void {
    this.setRepoVariable = callbacks.setRepoVariable;
    this.setOrgVariable = callbacks.setOrgVariable;
  }

  /**
   * Set the target repo or org for the heartbeat.
   */
  setTarget(target: HeartbeatTarget): void {
    this.target = target;
  }

  /**
   * Start the heartbeat - updates the variable every HEARTBEAT_INTERVAL_MS.
   */
  async start(): Promise<boolean> {
    if (!this.target) {
      this.log('error', 'Cannot start heartbeat: no target configured');
      return false;
    }

    if (!this.setRepoVariable || !this.setOrgVariable) {
      this.log('error', 'Cannot start heartbeat: API callbacks not configured');
      return false;
    }

    // Stop any existing heartbeat
    this.stop();

    // Try initial update (but don't fail if it doesn't work)
    try {
      await this.updateHeartbeat();
    } catch (error) {
      this.log('warn', `Initial heartbeat failed: ${(error as Error).message}`);
    }

    // Set up periodic updates - keep trying even if initial failed.
    // Note: We intentionally don't add retry logic here. If an update fails,
    // the next interval tick (60s later) will try again. Adding immediate
    // retries with backoff would delay recovery and hammer the GitHub API
    // during outages. The 60s/90s heartbeat window already provides tolerance
    // for occasional failures.
    this.intervalId = setInterval(async () => {
      try {
        await this.updateHeartbeat();
      } catch (error) {
        this.log('warn', `Heartbeat update failed: ${(error as Error).message}`);
      }
    }, HEARTBEAT_INTERVAL_MS);

    this.log('info', 'Heartbeat started');
    return true;
  }

  /**
   * Stop the heartbeat timer.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.log('info', 'Heartbeat stopped');
    }
  }

  /**
   * Clear the heartbeat by setting it to a stale timestamp.
   * This prevents workflows from dispatching jobs to orphaned runners.
   */
  async clear(): Promise<void> {
    if (!this.target) {
      return;
    }

    if (!this.setRepoVariable || !this.setOrgVariable) {
      return;
    }

    // Use epoch timestamp to indicate runner is offline
    const staleTimestamp = '1970-01-01T00:00:00Z';

    try {
      if (this.target.level === 'org' && this.target.org) {
        await this.setOrgVariable(this.target.org, HEARTBEAT_VARIABLE_NAME, staleTimestamp);
        this.log('info', `Cleared heartbeat for org ${this.target.org}`);
      } else if (this.target.level === 'repo' && this.target.owner && this.target.repo) {
        await this.setRepoVariable(this.target.owner, this.target.repo, HEARTBEAT_VARIABLE_NAME, staleTimestamp);
        this.log('info', `Cleared heartbeat for ${this.target.owner}/${this.target.repo}`);
      }
    } catch (error) {
      this.log('warn', `Failed to clear heartbeat: ${(error as Error).message}`);
    }
  }

  /**
   * Check if the heartbeat is currently running.
   */
  isRunning(): boolean {
    return this.intervalId !== null;
  }

  /**
   * Update the heartbeat variable with the current timestamp.
   */
  private async updateHeartbeat(): Promise<void> {
    if (!this.target) {
      throw new Error('No target configured');
    }

    const timestamp = new Date().toISOString();

    if (this.target.level === 'org' && this.target.org) {
      await this.setOrgVariable!(this.target.org, HEARTBEAT_VARIABLE_NAME, timestamp);
      this.log('info', `Updated heartbeat for org ${this.target.org}`);
    } else if (this.target.level === 'repo' && this.target.owner && this.target.repo) {
      await this.setRepoVariable!(this.target.owner, this.target.repo, HEARTBEAT_VARIABLE_NAME, timestamp);
      this.log('info', `Updated heartbeat for ${this.target.owner}/${this.target.repo}`);
    } else {
      throw new Error('Invalid target configuration');
    }
  }

  private log(level: 'info' | 'error' | 'warn', message: string): void {
    const prefix = this.runnerName ? `[Heartbeat ${this.runnerName}]` : '[Heartbeat]';
    if (this.onLog) {
      this.onLog(level, `${prefix} ${message}`);
    }
    // No fallback logging - if onLog not configured, messages are dropped
    // This is intentional: callers should always provide onLog
  }
}
