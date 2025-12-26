/**
 * Target Manager
 *
 * CRUD operations for managing targets (repos/orgs for multi-target runner support).
 * Targets are stored in the app config and persisted to disk.
 */

import * as os from 'os';
import * as crypto from 'crypto';
import { loadConfig, saveConfig } from './config';
import { getLogger } from './app-state';
import { getRunnerProxyManager } from './runner-proxy-manager';
import type { Target, Result } from '../shared/types';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a unique target ID.
 */
const generateTargetId = (): string => {
  return crypto.randomUUID().slice(0, 8);
};

/**
 * Generate the proxy runner name for a target.
 * Format: localmost.<hostname>.<target-name>
 */
const generateProxyRunnerName = (target: Pick<Target, 'type' | 'owner' | 'repo'>): string => {
  const hostname = os.hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const targetName = target.type === 'org'
    ? target.owner.toLowerCase()
    : `${target.owner}-${target.repo}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `localmost.${hostname}.${targetName}`;
};

/**
 * Generate display name for a target.
 */
const generateDisplayName = (target: Pick<Target, 'type' | 'owner' | 'repo'>): string => {
  return target.type === 'org'
    ? target.owner
    : `${target.owner}/${target.repo}`;
};

/**
 * Generate URL for a target.
 */
const generateUrl = (target: Pick<Target, 'type' | 'owner' | 'repo'>): string => {
  return target.type === 'org'
    ? `https://github.com/${target.owner}`
    : `https://github.com/${target.owner}/${target.repo}`;
};

// ============================================================================
// Target Manager
// ============================================================================

export class TargetManager {
  /**
   * Get all targets.
   */
  getTargets(): Target[] {
    const config = loadConfig();
    return config.targets || [];
  }

  /**
   * Get a target by ID.
   */
  getTarget(targetId: string): Target | undefined {
    return this.getTargets().find(t => t.id === targetId);
  }

  /**
   * Add a new target.
   * This will also register the runner proxy with GitHub.
   */
  async addTarget(
    type: 'repo' | 'org',
    owner: string,
    repo?: string
  ): Promise<Result<Target>> {
    const log = () => getLogger();

    // Validate input
    if (type === 'repo' && !repo) {
      return { success: false, error: 'Repository name is required for repo targets' };
    }

    // Check for duplicates
    const existing = this.getTargets();
    const isDuplicate = existing.some(t =>
      t.type === type &&
      t.owner === owner &&
      (type === 'org' || t.repo === repo)
    );
    if (isDuplicate) {
      return { success: false, error: 'This target already exists' };
    }

    // Create target object
    const target: Target = {
      id: generateTargetId(),
      type,
      owner,
      repo: type === 'repo' ? repo : undefined,
      displayName: generateDisplayName({ type, owner, repo }),
      url: generateUrl({ type, owner, repo }),
      proxyRunnerName: generateProxyRunnerName({ type, owner, repo }),
      enabled: true,
      addedAt: new Date().toISOString(),
    };

    log()?.info(`[TargetManager] Adding target: ${target.displayName}`);

    // Register runner proxies with GitHub (N instances for parallel jobs)
    const proxyManager = getRunnerProxyManager();
    const instanceCount = this.getMaxConcurrentJobs();
    try {
      await proxyManager.registerAll(target, instanceCount);
    } catch (error) {
      const message = (error as Error).message;
      log()?.error(`[TargetManager] Failed to register proxies: ${message}`);
      return { success: false, error: `Failed to register runner: ${message}` };
    }

    // Save to config
    const config = loadConfig();
    config.targets = [...(config.targets || []), target];
    saveConfig(config);

    log()?.info(`[TargetManager] Target added: ${target.displayName}`);
    return { success: true, data: target };
  }

  /**
   * Remove a target.
   * This will also unregister the runner proxy from GitHub.
   */
  async removeTarget(targetId: string): Promise<Result> {
    const log = () => getLogger();
    const target = this.getTarget(targetId);

    if (!target) {
      return { success: false, error: 'Target not found' };
    }

    log()?.info(`[TargetManager] Removing target: ${target.displayName}`);

    // Unregister all runner proxies from GitHub
    const proxyManager = getRunnerProxyManager();
    try {
      await proxyManager.unregisterAll(target);
    } catch (error) {
      log()?.warn(`[TargetManager] Failed to unregister proxies: ${(error as Error).message}`);
      // Continue with removal even if GitHub unregistration fails
    }

    // Remove from config
    const config = loadConfig();
    config.targets = (config.targets || []).filter(t => t.id !== targetId);
    saveConfig(config);

    log()?.info(`[TargetManager] Target removed: ${target.displayName}`);
    return { success: true };
  }

  /**
   * Update a target.
   */
  async updateTarget(
    targetId: string,
    updates: Partial<Pick<Target, 'enabled'>>
  ): Promise<Result<Target>> {
    const log = () => getLogger();
    const target = this.getTarget(targetId);

    if (!target) {
      return { success: false, error: 'Target not found' };
    }

    // Apply updates
    const updatedTarget: Target = {
      ...target,
      ...updates,
    };

    // Save to config
    const config = loadConfig();
    config.targets = (config.targets || []).map(t =>
      t.id === targetId ? updatedTarget : t
    );
    saveConfig(config);

    log()?.info(`[TargetManager] Target updated: ${updatedTarget.displayName}`);
    return { success: true, data: updatedTarget };
  }

  /**
   * Get maximum concurrent jobs setting.
   */
  getMaxConcurrentJobs(): number {
    const config = loadConfig();
    return config.maxConcurrentJobs ?? 4; // Default to 4
  }

  /**
   * Set maximum concurrent jobs.
   */
  setMaxConcurrentJobs(count: number): void {
    const log = () => getLogger();
    const config = loadConfig();
    const oldValue = config.maxConcurrentJobs ?? 4;
    const newValue = Math.max(1, Math.min(8, count));
    if (oldValue !== newValue) {
      log()?.info(`[Settings] maxConcurrentJobs: ${oldValue} -> ${newValue}`);
    }
    config.maxConcurrentJobs = newValue;
    saveConfig(config);
  }
}

// Singleton instance
let instance: TargetManager | null = null;

export const getTargetManager = (): TargetManager => {
  if (!instance) {
    instance = new TargetManager();
  }
  return instance;
};
