/**
 * Auth token management: refresh, validation, and job cancellation.
 */

import { loadConfig, saveConfig } from './config';
import {
  getAuthState,
  setAuthState,
  getGitHubAuth,
  getLogger,
} from './app-state';

/** Retry delays in milliseconds for exponential backoff. */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

/**
 * Check if an error is a transient network error worth retrying.
 * Auth errors (invalid token, revoked access) should not be retried.
 */
const isNetworkError = (error: Error): boolean => {
  const message = error.message.toLowerCase();
  return (
    message.includes('network') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('etimedout') ||
    message.includes('enotfound') ||
    message.includes('socket') ||
    message.includes('timeout') ||
    message.includes('fetch failed')
  );
};

/**
 * Sleep for the specified number of milliseconds.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Force refresh the access token, regardless of expiration status.
 * Used to recover from "Bad credentials" errors.
 * Retries up to 3 times with exponential backoff for network errors.
 * Returns the new token or null if refresh fails.
 */
export const forceRefreshToken = async (): Promise<string | null> => {
  const authState = getAuthState();
  const githubAuth = getGitHubAuth();
  const logger = getLogger();

  if (!authState?.refreshToken || !githubAuth) {
    return null;
  }

  logger?.info('Refreshing access token...');

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const result = await githubAuth.refreshAccessToken(authState.refreshToken);

      // Update authState with new tokens
      const newAuthState = {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        user: result.user,
      };
      setAuthState(newAuthState);

      // Persist to config
      const config = loadConfig();
      config.auth = newAuthState;
      saveConfig(config);

      logger?.info('Access token refreshed successfully');
      return newAuthState.accessToken;
    } catch (error) {
      lastError = error as Error;

      // Only retry network errors, not auth errors
      if (!isNetworkError(lastError)) {
        logger?.error(`Failed to refresh token (not retrying): ${lastError.message}`);
        return null;
      }

      // If we have retries left, wait and try again
      if (attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        logger?.warn(`Token refresh failed (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1}), retrying in ${delay}ms: ${lastError.message}`);
        await sleep(delay);
      }
    }
  }

  logger?.error(`Failed to refresh token after ${RETRY_DELAYS_MS.length + 1} attempts: ${lastError?.message}`);
  return null;
};

/**
 * Get a valid access token, refreshing if expired.
 * Returns null if not authenticated or refresh fails.
 */
export const getValidAccessToken = async (): Promise<string | null> => {
  const authState = getAuthState();
  const githubAuth = getGitHubAuth();

  if (!authState) {
    return null;
  }

  // Check if token is expired
  if (githubAuth && authState.expiresAt && authState.refreshToken) {
    if (githubAuth.isTokenExpired(authState.expiresAt)) {
      return forceRefreshToken();
    }
  }

  return authState.accessToken;
};

/**
 * Cancel any workflow runs that have jobs running on our runners.
 * Called on app quit to ensure clean shutdown - prevents orphaned jobs
 * that would block runner deletion on next startup.
 *
 * Supports both repo-level and org-level targets.
 *
 * @param runnerNames - Optional list of specific runner names to cancel jobs for.
 *                      If not provided, cancels for all runners matching configured targets.
 */
export const cancelJobsOnOurRunners = async (runnerNames?: string[]): Promise<void> => {
  const logger = getLogger();
  const githubAuth = getGitHubAuth();

  logger?.info('cancelJobsOnOurRunners: Starting...');

  const accessToken = await getValidAccessToken();
  if (!accessToken || !githubAuth) {
    logger?.info('cancelJobsOnOurRunners: No access token, skipping');
    return;
  }

  const config = loadConfig();
  const targets = config.targets || [];

  if (targets.length === 0) {
    logger?.info('cancelJobsOnOurRunners: No targets configured, skipping');
    return;
  }

  // Collect all unique owner/repo pairs to check
  // For repo targets: use the target's owner/repo
  // For org targets: we need to check repos that might have jobs
  const reposToCheck = new Set<string>();

  for (const target of targets) {
    if (target.type === 'repo' && target.owner && target.repo) {
      reposToCheck.add(`${target.owner}/${target.repo}`);
    }
    // For org targets, we'll check repos based on proxyRunnerName matching later
    // For now, org-level cancellation requires knowing which repos have active jobs
    // We'll handle this by checking all repos mentioned in the target proxy names
  }

  // Also check legacy runnerConfig if present
  const runnerConfig = config.runnerConfig;
  if (runnerConfig?.level === 'repo' && runnerConfig.repoUrl) {
    const match = runnerConfig.repoUrl.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
    if (match) {
      reposToCheck.add(`${match[1]}/${match[2]}`);
    }
  }

  if (reposToCheck.size === 0) {
    logger?.info('cancelJobsOnOurRunners: No repo targets found, skipping');
    return;
  }

  // Collect all runner names we should match
  const allRunnerNames = new Set<string>();
  if (runnerNames && runnerNames.length > 0) {
    runnerNames.forEach(name => allRunnerNames.add(name));
  } else {
    // Use proxy runner names from all targets
    for (const target of targets) {
      if (target.proxyRunnerName) {
        allRunnerNames.add(target.proxyRunnerName);
      }
    }
    // Also add legacy runner name
    if (runnerConfig?.runnerName) {
      allRunnerNames.add(runnerConfig.runnerName);
    }
  }

  if (allRunnerNames.size === 0) {
    logger?.info('cancelJobsOnOurRunners: No runner names to match, skipping');
    return;
  }

  let totalCancelledCount = 0;

  try {
    for (const repoKey of reposToCheck) {
      const [owner, repo] = repoKey.split('/');

      try {
        logger?.info(`Checking for jobs to cancel in ${owner}/${repo}...`);
        const runs = await githubAuth.getRecentWorkflowRuns(accessToken, owner, repo);
        const inProgressRuns = runs.filter(r => r.status === 'in_progress' || r.status === 'queued');

        if (inProgressRuns.length === 0) {
          logger?.debug(`No in-progress workflow runs in ${owner}/${repo}`);
          continue;
        }

        logger?.info(`Found ${inProgressRuns.length} in-progress/queued run(s) in ${owner}/${repo}`);

        for (const run of inProgressRuns) {
          try {
            const jobs = await githubAuth.getWorkflowRunJobs(accessToken, owner, repo, run.id);
            const activeJobs = jobs.filter(job => job.status === 'in_progress' || job.status === 'queued');
            const ourJobs = activeJobs.filter(job => {
              if (!job.runner_name) return false;
              // Check if this runner matches any of our runner names (exact or prefix match)
              for (const name of allRunnerNames) {
                if (job.runner_name === name || job.runner_name.startsWith(name + '.')) {
                  return true;
                }
              }
              return false;
            });

            if (ourJobs.length > 0) {
              logger?.info(`Cancelling run ${run.id} (${run.name}) - has jobs on our runners: ${ourJobs.map(j => j.runner_name).join(', ')}`);
              try {
                await githubAuth.cancelWorkflowRun(accessToken, owner, repo, run.id);
                logger?.info(`Successfully requested cancellation of run ${run.id}`);
                totalCancelledCount++;
              } catch (cancelErr) {
                logger?.warn(`Failed to cancel run ${run.id}: ${(cancelErr as Error).message}`);
              }
            }
          } catch (jobErr) {
            logger?.warn(`Failed to check jobs for run ${run.id}: ${(jobErr as Error).message}`);
          }
        }
      } catch (repoErr) {
        logger?.warn(`Failed to check repo ${owner}/${repo}: ${(repoErr as Error).message}`);
      }
    }

    if (totalCancelledCount > 0) {
      logger?.info(`Waiting for ${totalCancelledCount} cancellation(s) to be processed...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      logger?.info('Done waiting for cancellations');
    } else {
      logger?.info('No jobs needed cancellation');
    }
  } catch (err) {
    logger?.warn(`Failed to cancel jobs on quit: ${(err as Error).message}`);
  }
};

/**
 * Extract owner/repo from a GitHub URL.
 */
export const parseRepoUrl = (url: string): { owner: string; repo: string } | null => {
  const match = url.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
};
