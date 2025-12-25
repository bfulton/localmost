/**
 * Runner lifecycle management: registration, cleanup, and re-registration.
 */

import { loadConfig } from './config';
import { getValidAccessToken, cancelJobsOnOurRunners } from './auth-tokens';
import {
  getGitHubAuth,
  getRunnerDownloader,
  getRunnerManager,
  getLogger,
  getBusyInstances,
  getReregisteringInstances,
} from './app-state';
import { AppConfig } from './config';
import { DEFAULT_RUNNER_COUNT } from '../shared/constants';
import type { Target } from '../shared/types';

/** Delay before retry in milliseconds. */
const RETRY_DELAY_MS = 2000;

/**
 * Execute an async operation with a single retry on failure.
 * Logs the failure and waits before retrying.
 */
const withSingleRetry = async <T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<T> => {
  const logger = getLogger();
  try {
    return await operation();
  } catch (firstError) {
    logger?.warn(`${operationName} failed, retrying in ${RETRY_DELAY_MS}ms: ${(firstError as Error).message}`);
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    return await operation();
  }
};

/**
 * Represents a registration target with the info needed to list/delete runners.
 */
interface RegistrationTarget {
  type: 'repo' | 'org';
  owner: string;
  repo?: string;
  displayName: string;
}

/**
 * Get registration targets from config.
 * Uses new targets array if available, falls back to old runnerConfig.
 */
const getRegistrationTargets = (config: AppConfig): RegistrationTarget[] => {
  // New multi-target system
  if (config.targets && config.targets.length > 0) {
    return config.targets.map(t => ({
      type: t.type,
      owner: t.owner,
      repo: t.repo,
      displayName: t.displayName,
    }));
  }

  // Fall back to old runnerConfig for backward compatibility
  const runnerConfig = config.runnerConfig;
  if (!runnerConfig) {
    return [];
  }

  // Org-level runner
  if (runnerConfig.level === 'org' && runnerConfig.orgName) {
    return [{
      type: 'org',
      owner: runnerConfig.orgName,
      displayName: runnerConfig.orgName,
    }];
  }

  // Repo-level runner (check repoUrl regardless of level setting for robustness)
  if (runnerConfig.repoUrl) {
    const match = runnerConfig.repoUrl.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
    if (match) {
      const [, owner, repo] = match;
      return [{
        type: 'repo',
        owner,
        repo,
        displayName: `${owner}/${repo}`,
      }];
    }
  }

  return [];
};

/**
 * Delete a runner from GitHub by ID.
 * Handles both repo and org level runners.
 */
const deleteRunnerFromGitHub = async (
  accessToken: string,
  target: RegistrationTarget,
  runnerId: number
): Promise<void> => {
  const githubAuth = getGitHubAuth();
  if (!githubAuth) throw new Error('GitHub auth not initialized');

  if (target.type === 'org') {
    await githubAuth.deleteOrgRunner(accessToken, target.owner, runnerId);
  } else if (target.repo) {
    await githubAuth.deleteRunner(accessToken, target.owner, target.repo, runnerId);
  }
};

/**
 * List runners for a target (repo or org).
 */
const listRunnersForTarget = async (
  accessToken: string,
  target: RegistrationTarget
): Promise<Array<{ id: number; name: string; status: string }>> => {
  const githubAuth = getGitHubAuth();
  if (!githubAuth) throw new Error('GitHub auth not initialized');

  if (target.type === 'org') {
    return githubAuth.listOrgRunners(accessToken, target.owner);
  } else if (target.repo) {
    return githubAuth.listRunners(accessToken, target.owner, target.repo);
  }
  return [];
};

/**
 * Clear stale runner registrations from GitHub before starting.
 * This handles the "session already exists" error by force-removing runners
 * that are stuck in an offline state but still have an active session.
 *
 * Iterates through ALL configured targets to clean up runners.
 *
 * Note: We only remove runners matching our name pattern.
 * This is safe because:
 * - If the runner is truly offline (crashed), removing it lets us reconnect
 * - If the runner is online elsewhere, this is a conflict anyway
 * - The runner will re-register with new credentials on next config
 */
export const clearStaleRunnerRegistrations = async (): Promise<void> => {
  const logger = getLogger();
  const githubAuth = getGitHubAuth();
  const busyInstances = getBusyInstances();

  const accessToken = await getValidAccessToken();
  if (!accessToken || !githubAuth) {
    return; // Can't clear without auth
  }

  const config = loadConfig();
  const runnerConfig = config.runnerConfig;
  if (!runnerConfig?.runnerName) {
    return; // No runner name configured
  }

  const targets = getRegistrationTargets(config);
  if (targets.length === 0) {
    return; // No targets configured
  }

  const baseRunnerName = runnerConfig.runnerName;
  const runnerCount = runnerConfig.runnerCount || DEFAULT_RUNNER_COUNT;

  // Clear busy instances from previous run
  busyInstances.clear();

  // Collect all matching runners across all targets
  const allMatchingRunners: Array<{
    id: number;
    name: string;
    status: string;
    target: RegistrationTarget;
  }> = [];

  // First pass: list runners from all targets
  // Only clean up WORKER runners (instance-based names like localmost.blue-243.1)
  // Do NOT clean up PROXY runners (target-based names like localmost.blue-243.bfulton-localmost)
  // Proxy runners are managed separately and needed for multi-target support
  for (const target of targets) {
    try {
      const existingRunners = await listRunnersForTarget(accessToken, target);
      const escapedBase = baseRunnerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Find WORKER runners matching instance-based names (e.g., localmost.blue-243.1)
      const matchingRunners = existingRunners.filter(r => {
        const instanceMatch = r.name.match(new RegExp(`^${escapedBase}\\.(\\d+)$`));
        if (!instanceMatch) return false;
        const instanceNum = parseInt(instanceMatch[1], 10);
        return instanceNum >= 1 && instanceNum <= runnerCount;
      });

      // Add target context to each runner
      for (const runner of matchingRunners) {
        allMatchingRunners.push({ ...runner, target });
      }
    } catch (err) {
      logger?.warn(`Could not list runners for ${target.displayName}: ${(err as Error).message}`);
    }
  }

  // Second pass: delete all matching runners
  if (allMatchingRunners.length > 0) {
    logger?.info(`Cleaning up ${allMatchingRunners.length} existing runner registration(s) across ${targets.length} target(s)...`);

    for (const runner of allMatchingRunners) {
      try {
        await deleteRunnerFromGitHub(accessToken, runner.target, runner.id);
        logger?.info(`Deleted runner "${runner.name}" from ${runner.target.displayName}`);
      } catch (err) {
        const errorMessage = (err as Error).message;
        logger?.warn(`Could not remove runner "${runner.name}" from ${runner.target.displayName}: ${errorMessage}`);

        // Track instances that are busy with jobs
        if (errorMessage.includes('currently running a job')) {
          const instanceMatch = runner.name.match(/\.(\d+)$/);
          if (instanceMatch) {
            const instanceNum = parseInt(instanceMatch[1], 10);
            busyInstances.add(instanceNum);
            logger?.info(`Instance ${instanceNum} is busy with a job, will try to cancel and skip registration`);
          }
        }
      }
    }

    // If any instances are busy, try to cancel their jobs
    if (busyInstances.size > 0) {
      const busyRunnerNames = Array.from(busyInstances).map(n => `${baseRunnerName}.${n}`);
      logger?.info(`Attempting to cancel jobs for busy runners: ${busyRunnerNames.join(', ')}`);
      await cancelJobsOnOurRunners(busyRunnerNames);

      // After cancellation, retry deleting the busy runners
      for (const instanceNum of busyInstances) {
        const runnerName = `${baseRunnerName}.${instanceNum}`;
        const runner = allMatchingRunners.find(r => r.name === runnerName);
        if (runner) {
          try {
            logger?.info(`Retrying deletion of ${runnerName} after cancellation...`);
            await deleteRunnerFromGitHub(accessToken, runner.target, runner.id);
            busyInstances.delete(instanceNum);
            logger?.info(`Successfully deleted ${runnerName} after cancellation`);
          } catch (retryErr) {
            logger?.warn(`Still cannot delete ${runnerName}: ${(retryErr as Error).message}`);
          }
        }
      }
    }
  }

  // Ensure all target proxy registrations exist
  // This is needed because proxy registrations may have been deleted from GitHub
  await ensureProxyRegistrations(config, accessToken);

  // Workers are spawned on-demand when jobs arrive via broker proxy
  // No need to pre-register worker runners here
};

/**
 * Ensure all targets have valid proxy registrations on GitHub.
 * Re-registers proxies that are missing or were deleted.
 */
const ensureProxyRegistrations = async (
  config: AppConfig,
  accessToken: string
): Promise<void> => {
  const logger = getLogger();
  const targets = config.targets || [];

  if (targets.length === 0) {
    return;
  }

  const { getRunnerProxyManager } = await import('./runner-proxy-manager');
  const proxyManager = getRunnerProxyManager();

  for (const target of targets) {
    if (!target.enabled) continue;

    try {
      // Check if proxy runner exists on GitHub
      const runners = await listRunnersForTarget(accessToken, {
        type: target.type,
        owner: target.owner,
        repo: target.repo,
        displayName: target.displayName,
      });

      const proxyRunner = runners.find(r => r.name === target.proxyRunnerName);

      if (!proxyRunner) {
        logger?.info(`[Proxy] Re-registering missing proxy for ${target.displayName}...`);
        try {
          await proxyManager.register(target);
          logger?.info(`[Proxy] Successfully re-registered proxy for ${target.displayName}`);
        } catch (regErr) {
          logger?.error(`[Proxy] Failed to re-register proxy for ${target.displayName}: ${(regErr as Error).message}`);
        }
      } else {
        logger?.debug(`[Proxy] Proxy exists for ${target.displayName}: ${proxyRunner.name} (${proxyRunner.status})`);
      }
    } catch (err) {
      logger?.warn(`[Proxy] Could not check proxy registration for ${target.displayName}: ${(err as Error).message}`);
    }
  }
};

/**
 * Re-register a single runner instance after detecting session conflict or registration deletion.
 * This stops the instance, deletes the GitHub registration, clears config, re-registers, and restarts.
 */
export const reRegisterSingleInstance = async (
  instanceNum: number,
  reason: 'session_conflict' | 'registration_deleted'
): Promise<void> => {
  const reregisteringInstances = getReregisteringInstances();

  // Prevent concurrent re-registration of the same instance
  if (reregisteringInstances.has(instanceNum)) {
    getLogger()?.debug(`Instance ${instanceNum} already being re-registered, skipping`);
    return;
  }
  reregisteringInstances.add(instanceNum);

  try {
    await doReRegisterInstance(instanceNum, reason);
  } finally {
    reregisteringInstances.delete(instanceNum);
  }
};

const doReRegisterInstance = async (
  instanceNum: number,
  reason: 'session_conflict' | 'registration_deleted'
): Promise<void> => {
  const githubAuth = getGitHubAuth();
  const runnerDownloader = getRunnerDownloader();
  const runnerManager = getRunnerManager();
  const logger = getLogger();

  if (!githubAuth || !runnerDownloader || !runnerManager) return;

  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    logger?.error('Cannot re-register: not authenticated');
    return;
  }

  const config = loadConfig();
  const runnerConfig = config.runnerConfig;
  if (!runnerConfig?.runnerName) {
    logger?.error('Cannot re-register: no runner config');
    return;
  }

  const targets = getRegistrationTargets(config);
  if (targets.length === 0) {
    logger?.error('Cannot re-register: no targets configured');
    return;
  }

  const baseRunnerName = runnerConfig.runnerName;
  const instanceName = `${baseRunnerName}.${instanceNum}`;

  logger?.info(`Re-registering instance ${instanceNum} (reason: ${reason})...`);

  // Stop the runner instance first
  await runnerManager.stopInstance(instanceNum);

  // For session conflicts, we need to delete the runner registration from GitHub
  // to clear the stale session. Delete from ALL targets that might have this runner.
  if (reason === 'session_conflict') {
    for (const target of targets) {
      try {
        // Find and delete the runner with this name from this target
        const runners = await listRunnersForTarget(accessToken, target);
        const runner = runners.find((r: { id: number; name: string; status: string }) => r.name === instanceName);
        if (runner) {
          logger?.info(`Deleting GitHub registration for ${instanceName} from ${target.displayName} (id: ${runner.id})...`);
          await deleteRunnerFromGitHub(accessToken, target, runner.id);
          logger?.info(`Deleted runner "${instanceName}" from ${target.displayName}`);
        }
      } catch (err) {
        const errorMessage = (err as Error).message;
        logger?.warn(`Could not delete runner "${instanceName}" from ${target.displayName}: ${errorMessage}`);

        // If the runner is currently running a job, we can't clear the session.
        // Don't continue with re-registration - it will just fail again with session conflict.
        if (errorMessage.includes('currently running a job')) {
          logger?.warn(`Runner ${instanceName} is busy with a job. Will retry when the job completes.`);
          return; // Exit without re-registering - prevents infinite loop
        }
        // For other errors, continue - the registration might already be gone
      }
    }
  }

  // Clear local config
  await runnerDownloader.clearConfig(instanceNum);

  // Use the first target for registration
  const primaryTarget = targets[0];
  let registrationToken: string;
  let configUrl: string;

  if (primaryTarget.type === 'org') {
    registrationToken = await withSingleRetry(
      () => githubAuth.getOrgRunnerRegistrationToken(accessToken, primaryTarget.owner),
      'Get org registration token'
    );
    configUrl = `https://github.com/${primaryTarget.owner}`;
  } else if (primaryTarget.repo) {
    registrationToken = await withSingleRetry(
      () => githubAuth.getRunnerRegistrationToken(accessToken, primaryTarget.owner, primaryTarget.repo!),
      'Get repo registration token'
    );
    configUrl = `https://github.com/${primaryTarget.owner}/${primaryTarget.repo}`;
  } else {
    throw new Error('No valid target configured');
  }

  const version = runnerDownloader.getInstalledVersion();
  if (!version) throw new Error('No runner version installed');

  // Re-register this instance
  await runnerDownloader.configureInstance(instanceNum, version, {
    url: configUrl,
    token: registrationToken,
    name: instanceName,
    labels: runnerConfig.labels?.split(',').map(l => l.trim()) || [],
    onLog: (level, message) => {
      if (level === 'info') logger?.info(`[config ${instanceNum}] ${message}`);
      else logger?.error(`[config ${instanceNum}] ${message}`);
    },
  });

  logger?.info(`Re-registration of instance ${instanceNum} complete, restarting...`);

  // Restart the instance
  await runnerManager.startInstance(instanceNum);
};

/**
 * Re-register instance 1 after cleaning up stale registrations.
 * Other instances are configured lazily when needed (lazy configuration).
 */
export const reRegisterRunner1 = async (
  runnerConfig: NonNullable<AppConfig['runnerConfig']>,
  accessToken: string,
  skipInstances: Set<number> = new Set(),
  target?: RegistrationTarget
): Promise<void> => {
  const githubAuth = getGitHubAuth();
  const runnerDownloader = getRunnerDownloader();
  const logger = getLogger();

  if (!githubAuth || !runnerDownloader) return;

  const runnerCount = runnerConfig.runnerCount || DEFAULT_RUNNER_COUNT;

  // Clear configs for instances 2-N so lazy configuration will trigger
  // (otherwise stale configs cause "registration deleted" errors)
  for (let i = 2; i <= runnerCount; i++) {
    if (!skipInstances.has(i)) {
      await runnerDownloader.clearConfig(i);
    }
  }

  // Only re-register instance 1 - others are configured lazily when scaling up
  if (skipInstances.has(1)) {
    logger?.info(`Skipping instance 1 - still running a job on GitHub`);
    return;
  }

  const baseRunnerName = runnerConfig.runnerName!;

  // Determine registration target - use provided target, or fall back to config
  let registrationTarget = target;
  if (!registrationTarget) {
    // Fall back to old runnerConfig format
    if (runnerConfig.level === 'org' && runnerConfig.orgName) {
      registrationTarget = {
        type: 'org',
        owner: runnerConfig.orgName,
        displayName: runnerConfig.orgName,
      };
    } else if (runnerConfig.repoUrl) {
      const match = runnerConfig.repoUrl.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
      if (match) {
        const [, owner, repo] = match;
        registrationTarget = {
          type: 'repo',
          owner,
          repo,
          displayName: `${owner}/${repo}`,
        };
      }
    }
  }

  if (!registrationTarget) {
    throw new Error('No registration target configured');
  }

  // Get registration token (with single retry for transient failures)
  let registrationToken: string;
  let configUrl: string;

  if (registrationTarget.type === 'org') {
    registrationToken = await withSingleRetry(
      () => githubAuth.getOrgRunnerRegistrationToken(accessToken, registrationTarget!.owner),
      'Get org registration token'
    );
    configUrl = `https://github.com/${registrationTarget.owner}`;
  } else if (registrationTarget.repo) {
    registrationToken = await withSingleRetry(
      () => githubAuth.getRunnerRegistrationToken(accessToken, registrationTarget!.owner, registrationTarget!.repo!),
      'Get repo registration token'
    );
    configUrl = `https://github.com/${registrationTarget.owner}/${registrationTarget.repo}`;
  } else {
    throw new Error('Invalid target configuration');
  }

  const version = runnerDownloader.getInstalledVersion();
  if (!version) throw new Error('No runner version installed');

  const instanceName = `${baseRunnerName}.1`;
  logger?.info(`Re-registering runner ${instanceName} with ${registrationTarget.displayName}...`);

  // Clear existing config before re-registering
  await runnerDownloader.clearConfig(1);

  await runnerDownloader.configureInstance(1, version, {
    url: configUrl,
    token: registrationToken,
    name: instanceName,
    labels: runnerConfig.labels?.split(',').map(l => l.trim()) || [],
    onLog: (level, message) => {
      if (level === 'info') logger?.info(`[config 1] ${message}`);
      else logger?.error(`[config 1] ${message}`);
    },
  });

  logger?.info('Runner re-registration complete');
};

/**
 * Configure a single runner instance on-demand (lazy configuration).
 * This is called by runner-manager when scaling up to an unconfigured instance.
 */
export const configureSingleInstance = async (instanceNum: number): Promise<void> => {
  const githubAuth = getGitHubAuth();
  const runnerDownloader = getRunnerDownloader();
  const logger = getLogger();

  if (!githubAuth || !runnerDownloader) {
    throw new Error('Runner not initialized');
  }

  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    throw new Error('Not authenticated');
  }

  const config = loadConfig();
  const runnerConfig = config.runnerConfig;
  if (!runnerConfig?.runnerName) {
    throw new Error('No runner config');
  }

  const targets = getRegistrationTargets(config);
  if (targets.length === 0) {
    throw new Error('No targets configured');
  }

  const baseRunnerName = runnerConfig.runnerName;
  const instanceName = `${baseRunnerName}.${instanceNum}`;

  // Use the first target for registration
  const primaryTarget = targets[0];

  logger?.info(`Lazy configuring instance ${instanceNum}: ${instanceName} with ${primaryTarget.displayName}...`);

  // Get registration token (with single retry for transient failures)
  let registrationToken: string;
  let configUrl: string;

  if (primaryTarget.type === 'org') {
    registrationToken = await withSingleRetry(
      () => githubAuth.getOrgRunnerRegistrationToken(accessToken, primaryTarget.owner),
      'Get org registration token'
    );
    configUrl = `https://github.com/${primaryTarget.owner}`;
  } else if (primaryTarget.repo) {
    registrationToken = await withSingleRetry(
      () => githubAuth.getRunnerRegistrationToken(accessToken, primaryTarget.owner, primaryTarget.repo!),
      'Get repo registration token'
    );
    configUrl = `https://github.com/${primaryTarget.owner}/${primaryTarget.repo}`;
  } else {
    throw new Error('Invalid target configuration');
  }

  const version = runnerDownloader.getInstalledVersion();
  if (!version) throw new Error('No runner version installed');

  // Configure this instance
  await runnerDownloader.configureInstance(instanceNum, version, {
    url: configUrl,
    token: registrationToken,
    name: instanceName,
    labels: runnerConfig.labels?.split(',').map(l => l.trim()) || [],
    onLog: (level, message) => {
      if (level === 'info') logger?.info(`[config ${instanceNum}] ${message}`);
      else logger?.error(`[config ${instanceNum}] ${message}`);
    },
  });

  logger?.info(`Lazy configuration of instance ${instanceNum} complete`);
};
