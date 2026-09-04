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
import type { Target } from '../shared/types';

/** Timestamp written to mark a target offline. */
const STALE_TIMESTAMP = '1970-01-01T00:00:00Z';

/** Configuration for a target repo or org */
export interface HeartbeatTarget {
  level: 'repo' | 'org';
  owner?: string;  // For repo level
  repo?: string;   // For repo level
  org?: string;    // For org level
}

/**
 * Whether two heartbeat targets refer to the same repo or org.
 */
const sameTarget = (a: HeartbeatTarget, b: HeartbeatTarget): boolean => {
  if (a.level !== b.level) return false;
  return a.level === 'org' ? a.org === b.org : a.owner === b.owner && a.repo === b.repo;
};

/**
 * Map a configured target to its heartbeat target.
 */
export const toHeartbeatTarget = (target: Target): HeartbeatTarget =>
  target.type === 'org'
    ? { level: 'org', org: target.owner }
    : { level: 'repo', owner: target.owner, repo: target.repo };

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
   * Add a target to the heartbeat. Targets can be added while the app is
   * running (from the CLI or the Targets page), so heartbeat it immediately
   * rather than leaving the repo looking offline until the next tick.
   */
  async addTarget(target: HeartbeatTarget): Promise<void> {
    if (this.targets.some(t => sameTarget(t, target))) {
      return;
    }

    this.targets.push(target);

    if (!this.isRunning()) {
      return;
    }

    try {
      await this.updateHeartbeat(target, new Date().toISOString());
    } catch (error) {
      this.log('warn', `Heartbeat failed for ${this.targetName(target)}: ${(error as Error).message}`);
    }
  }

  /**
   * Remove a target from the heartbeat, marking it stale so workflows stop
   * dispatching jobs to runners that are going away.
   *
   * Clearing is not gated on the heartbeat running: a paused runner has
   * stopped the timer but may have written a recent timestamp moments before,
   * which would keep the target looking online for the rest of the window.
   */
  async removeTarget(target: HeartbeatTarget): Promise<void> {
    const before = this.targets.length;
    this.targets = this.targets.filter(t => !sameTarget(t, target));

    if (this.targets.length === before) {
      return;
    }

    await this.clearHeartbeat(target);
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

    // Clear all heartbeats in parallel with a short timeout for fast shutdown
    const clearPromises = this.targets.map(target => this.clearHeartbeat(target));

    // Wait up to 3 seconds for heartbeat clearing, then continue shutdown.
    // The timer is cleared either way so it can't hold the process open.
    let timeoutId: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, 3000);
    });

    try {
      await Promise.race([Promise.all(clearPromises), timeout]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
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
   * Mark a single target offline. Best-effort: a failure here must not block
   * shutdown or target removal.
   */
  private async clearHeartbeat(target: HeartbeatTarget): Promise<void> {
    try {
      if (target.level === 'org' && target.org && this.setOrgVariable) {
        await this.setOrgVariable(target.org, HEARTBEAT_VARIABLE_NAME, STALE_TIMESTAMP);
        this.log('info', `Cleared heartbeat for org ${target.org}`);
      } else if (target.level === 'repo' && target.owner && target.repo && this.setRepoVariable) {
        await this.setRepoVariable(target.owner, target.repo, HEARTBEAT_VARIABLE_NAME, STALE_TIMESTAMP);
        this.log('info', `Cleared heartbeat for ${target.owner}/${target.repo}`);
      }
    } catch (error) {
      this.log('warn', `Failed to clear heartbeat for ${this.targetName(target)}: ${(error as Error).message}`);
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
