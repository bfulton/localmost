/**
 * HeartbeatManager - Manages GitHub Actions variables that serve as heartbeats
 * to indicate that the localmost runner is online and available.
 *
 * Instead of requiring a token and API permissions to check runner status,
 * workflows can simply read the LOCALMOST_HEARTBEAT variable and check if
 * the timestamp is recent (less than ~90 seconds old).
 *
 * Supports multiple targets - updates heartbeat for all configured repos/orgs.
 */

import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_VARIABLE_NAME } from '../shared/constants';

/** Configuration for a target repo or org */
export interface HeartbeatTarget {
  level: 'repo' | 'org';
  owner?: string;  // For repo level
  repo?: string;   // For repo level
  org?: string;    // For org level
}

export class HeartbeatManager {
  private intervalId: NodeJS.Timeout | null = null;
  private targets: HeartbeatTarget[] = [];
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
   * Set all targets for the heartbeat.
   */
  setTargets(targets: HeartbeatTarget[]): void {
    this.targets = targets;
  }

  /**
   * Start the heartbeat - updates the variable every HEARTBEAT_INTERVAL_MS for all targets.
   */
  async start(): Promise<boolean> {
    if (this.targets.length === 0) {
      this.log('info', 'No targets configured, heartbeat not started');
      return false;
    }

    if (!this.setRepoVariable || !this.setOrgVariable) {
      this.log('error', 'Cannot start heartbeat: API callbacks not configured');
      return false;
    }

    // Stop any existing heartbeat
    this.stop();

    // Try initial update for all targets (but don't fail if some don't work)
    await this.updateAllHeartbeats();

    // Set up periodic updates - keep trying even if initial failed.
    // Note: We intentionally don't add retry logic here. If an update fails,
    // the next interval tick (60s later) will try again. Adding immediate
    // retries with backoff would delay recovery and hammer the GitHub API
    // during outages. The 60s/90s heartbeat window already provides tolerance
    // for occasional failures.
    this.intervalId = setInterval(async () => {
      await this.updateAllHeartbeats();
    }, HEARTBEAT_INTERVAL_MS);

    this.log('info', `Heartbeat started for ${this.targets.length} target(s)`);
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
   * Clear all heartbeats by setting them to a stale timestamp.
   * This prevents workflows from dispatching jobs to orphaned runners.
   */
  async clear(): Promise<void> {
    if (this.targets.length === 0) {
      return;
    }

    if (!this.setRepoVariable || !this.setOrgVariable) {
      return;
    }

    // Use epoch timestamp to indicate runner is offline
    const staleTimestamp = '1970-01-01T00:00:00Z';

    // Clear all heartbeats in parallel with a short timeout for fast shutdown
    const clearPromises = this.targets.map(async (target) => {
      try {
        if (target.level === 'org' && target.org) {
          await this.setOrgVariable(target.org, HEARTBEAT_VARIABLE_NAME, staleTimestamp);
          this.log('info', `Cleared heartbeat for org ${target.org}`);
        } else if (target.level === 'repo' && target.owner && target.repo) {
          await this.setRepoVariable(target.owner, target.repo, HEARTBEAT_VARIABLE_NAME, staleTimestamp);
          this.log('info', `Cleared heartbeat for ${target.owner}/${target.repo}`);
        }
      } catch (error) {
        this.log('warn', `Failed to clear heartbeat for ${this.targetName(target)}: ${(error as Error).message}`);
      }
    });

    // Wait up to 3 seconds for heartbeat clearing, then continue shutdown
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));
    await Promise.race([Promise.all(clearPromises), timeout]);
  }

  /**
   * Check if the heartbeat is currently running.
   */
  isRunning(): boolean {
    return this.intervalId !== null;
  }

  /**
   * Update heartbeat for all targets.
   */
  private async updateAllHeartbeats(): Promise<void> {
    const timestamp = new Date().toISOString();

    for (const target of this.targets) {
      try {
        await this.updateHeartbeat(target, timestamp);
      } catch (error) {
        this.log('warn', `Heartbeat failed for ${this.targetName(target)}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Update the heartbeat variable for a single target.
   */
  private async updateHeartbeat(target: HeartbeatTarget, timestamp: string): Promise<void> {
    if (target.level === 'org' && target.org) {
      await this.setOrgVariable!(target.org, HEARTBEAT_VARIABLE_NAME, timestamp);
      this.log('info', `Heartbeat updated for org:${target.org}`);
    } else if (target.level === 'repo' && target.owner && target.repo) {
      await this.setRepoVariable!(target.owner, target.repo, HEARTBEAT_VARIABLE_NAME, timestamp);
      this.log('info', `Heartbeat updated for ${target.owner}/${target.repo}`);
    } else {
      throw new Error('Invalid target configuration');
    }
  }

  /**
   * Get a display name for a target.
   */
  private targetName(target: HeartbeatTarget): string {
    if (target.level === 'org' && target.org) {
      return `org:${target.org}`;
    } else if (target.level === 'repo' && target.owner && target.repo) {
      return `${target.owner}/${target.repo}`;
    }
    return 'unknown';
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
