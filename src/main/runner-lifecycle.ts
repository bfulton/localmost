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
 * Clear stale runner registrations from GitHub before starting.
 * This handles the "session already exists" error by force-removing runners
 * that are stuck in an offline state but still have an active session.
 *
 * Note: We only remove runners matching our name pattern that are offline.
 * This is safe because:
 * - If the runner is truly offline (crashed), removing it lets us reconnect
 * - If the runner is online, we won't remove it (status check)
 * - The runner will re-register with the same credentials on next config
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

  const baseRunnerName = runnerConfig.runnerName;
  const runnerCount = runnerConfig.runnerCount || DEFAULT_RUNNER_COUNT;

  // Clear busy instances from previous run
  busyInstances.clear();

  try {
    let existingRunners: Array<{ id: number; name: string; status: string }>;

    if (runnerConfig.level === 'org' && runnerConfig.orgName) {
      existingRunners = await githubAuth.listOrgRunners(accessToken, runnerConfig.orgName);
    } else if (runnerConfig.level === 'repo' && runnerConfig.repoUrl) {
      const match = runnerConfig.repoUrl.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
      if (!match) return;
      const [, owner, repo] = match;
      existingRunners = await githubAuth.listRunners(accessToken, owner, repo);
    } else {
      return;
    }

    // Find runners matching our name pattern
    const matchingRunners = existingRunners.filter(r => {
      // Check if it matches our name pattern (baseRunnerName.N)
      const match = r.name.match(new RegExp(`^${baseRunnerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)$`));
      if (!match) return false;

      // Only consider it if the instance number is within our configured range
      const instanceNum = parseInt(match[1], 10);
      return instanceNum >= 1 && instanceNum <= runnerCount;
    });

    // Always clean up existing runners with our names before starting.
    // This prevents session conflicts - GitHub's "online" status is unreliable after crashes.
    if (matchingRunners.length > 0) {
      logger?.info(`Cleaning up ${matchingRunners.length} existing runner registration(s)...`);

      for (const runner of matchingRunners) {
        try {
          if (runnerConfig.level === 'org' && runnerConfig.orgName) {
            await githubAuth.deleteOrgRunner(accessToken, runnerConfig.orgName, runner.id);
          } else if (runnerConfig.repoUrl) {
            const match = runnerConfig.repoUrl.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
            if (match) {
              const [, owner, repo] = match;
              await githubAuth.deleteRunner(accessToken, owner, repo, runner.id);
            }
          }
        } catch (err) {
          const errorMessage = (err as Error).message;
          logger?.warn(`Could not remove runner "${runner.name}": ${errorMessage}`);

          // Track instances that are busy with jobs - we shouldn't try to start these
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
      // This is a fallback for cases where quit-time cancellation didn't complete
      if (busyInstances.size > 0) {
        const busyRunnerNames = Array.from(busyInstances).map(n => `${baseRunnerName}.${n}`);
        logger?.info(`Attempting to cancel jobs for busy runners: ${busyRunnerNames.join(', ')}`);
        await cancelJobsOnOurRunners(busyRunnerNames);

        // After cancellation, retry deleting the busy runners
        for (const instanceNum of busyInstances) {
          const runnerName = `${baseRunnerName}.${instanceNum}`;
          const runner = matchingRunners.find(r => r.name === runnerName);
          if (runner) {
            try {
              logger?.info(`Retrying deletion of ${runnerName} after cancellation...`);
              if (runnerConfig.level === 'org' && runnerConfig.orgName) {
                await githubAuth.deleteOrgRunner(accessToken, runnerConfig.orgName, runner.id);
              } else if (runnerConfig.repoUrl) {
                const match = runnerConfig.repoUrl.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
                if (match) {
                  const [, owner, repo] = match;
                  await githubAuth.deleteRunner(accessToken, owner, repo, runner.id);
                }
              }
              // Successfully deleted - remove from busy set so we can register it
              busyInstances.delete(instanceNum);
              logger?.info(`Successfully deleted ${runnerName} after cancellation`);
            } catch (retryErr) {
              logger?.warn(`Still cannot delete ${runnerName}: ${(retryErr as Error).message}`);
            }
          }
        }
      }
    }

    // Register instance 1 (other instances configured lazily when scaling up)
    logger?.info('Registering runner 1...');
    try {
      await reRegisterRunner1(runnerConfig, accessToken, busyInstances);
    } catch (err) {
      logger?.error(`Failed to register runner: ${(err as Error).message}`);
      throw err;
    }
  } catch (err) {
    logger?.warn(`Could not check for stale runners: ${(err as Error).message}`);
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

  const baseRunnerName = runnerConfig.runnerName;
  const instanceName = `${baseRunnerName}.${instanceNum}`;

  logger?.info(`Re-registering instance ${instanceNum} (reason: ${reason})...`);

  // Stop the runner instance first
  await runnerManager.stopInstance(instanceNum);

  // For session conflicts, we need to delete the runner registration from GitHub
  // to clear the stale session
  if (reason === 'session_conflict') {
    try {
      let owner: string | undefined;
      let repo: string | undefined;

      if (runnerConfig.level === 'org' && runnerConfig.orgName) {
        // For org-level runners, we'd need a different API - skip for now
        logger?.warn('Org-level runner re-registration not yet implemented');
      } else if (runnerConfig.repoUrl) {
        const match = runnerConfig.repoUrl.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
        if (match) {
          [, owner, repo] = match;
        }
      }

      if (owner && repo) {
        // Find and delete the runner with this name
        const runners = await githubAuth.listRunners(accessToken, owner, repo);
        const runner = runners.find((r: { id: number; name: string; status: string }) => r.name === instanceName);
        if (runner) {
          logger?.info(`Deleting GitHub registration for ${instanceName} (id: ${runner.id})...`);
          await githubAuth.deleteRunner(accessToken, owner, repo, runner.id);
        }
      }
    } catch (err) {
      const errorMessage = (err as Error).message;
      logger?.error(`Failed to delete runner registration: ${errorMessage}`);

      // If the runner is currently running a job, we can't clear the session.
      // Don't continue with re-registration - it will just fail again with session conflict.
      // The user needs to wait for the job to finish.
      if (errorMessage.includes('currently running a job')) {
        logger?.warn(`Runner ${instanceName} is busy with a job. Will retry when the job completes.`);
        return; // Exit without re-registering - prevents infinite loop
      }
      // For other errors, continue - the registration might already be gone
    }
  }

  // Clear local config
  await runnerDownloader.clearConfig(instanceNum);

  // Get registration token (with single retry for transient failures)
  let registrationToken: string;
  let configUrl: string;

  if (runnerConfig.level === 'org' && runnerConfig.orgName) {
    registrationToken = await withSingleRetry(
      () => githubAuth.getOrgRunnerRegistrationToken(accessToken, runnerConfig.orgName!),
      'Get org registration token'
    );
    configUrl = `https://github.com/${runnerConfig.orgName}`;
  } else if (runnerConfig.repoUrl) {
    const match = runnerConfig.repoUrl.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
    if (!match) throw new Error('Invalid repo URL');
    const [, owner, repo] = match;
    registrationToken = await withSingleRetry(
      () => githubAuth.getRunnerRegistrationToken(accessToken, owner, repo),
      'Get repo registration token'
    );
    configUrl = `https://github.com/${owner}/${repo}`;
  } else {
    throw new Error('No repo or org configured');
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
  skipInstances: Set<number> = new Set()
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

  // Get registration token (with single retry for transient failures)
  let registrationToken: string;
  let configUrl: string;

  if (runnerConfig.level === 'org' && runnerConfig.orgName) {
    registrationToken = await withSingleRetry(
      () => githubAuth.getOrgRunnerRegistrationToken(accessToken, runnerConfig.orgName!),
      'Get org registration token'
    );
    configUrl = `https://github.com/${runnerConfig.orgName}`;
  } else if (runnerConfig.repoUrl) {
    const match = runnerConfig.repoUrl.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
    if (!match) throw new Error('Invalid repo URL');
    const [, owner, repo] = match;
    registrationToken = await withSingleRetry(
      () => githubAuth.getRunnerRegistrationToken(accessToken, owner, repo),
      'Get repo registration token'
    );
    configUrl = `https://github.com/${owner}/${repo}`;
  } else {
    throw new Error('No repo or org configured');
  }

  const version = runnerDownloader.getInstalledVersion();
  if (!version) throw new Error('No runner version installed');

  const instanceName = `${baseRunnerName}.1`;
  logger?.info(`Re-registering runner ${instanceName}...`);

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

  const baseRunnerName = runnerConfig.runnerName;
  const instanceName = `${baseRunnerName}.${instanceNum}`;

  logger?.info(`Lazy configuring instance ${instanceNum}: ${instanceName}...`);

  // Get registration token (with single retry for transient failures)
  let registrationToken: string;
  let configUrl: string;

  if (runnerConfig.level === 'org' && runnerConfig.orgName) {
    registrationToken = await withSingleRetry(
      () => githubAuth.getOrgRunnerRegistrationToken(accessToken, runnerConfig.orgName!),
      'Get org registration token'
    );
    configUrl = `https://github.com/${runnerConfig.orgName}`;
  } else if (runnerConfig.repoUrl) {
    const match = runnerConfig.repoUrl.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
    if (!match) throw new Error('Invalid repo URL');
    const [, owner, repo] = match;
    registrationToken = await withSingleRetry(
      () => githubAuth.getRunnerRegistrationToken(accessToken, owner, repo),
      'Get repo registration token'
    );
    configUrl = `https://github.com/${owner}/${repo}`;
  } else {
    throw new Error('No repo or org configured');
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
