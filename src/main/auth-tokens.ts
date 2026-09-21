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
/**
 * Whether a refresh failure proves the session is over.
 *
 * Not every non-network failure does. refreshAccessToken throws for 429 and
 * 5xx as well, and for a failed user lookup; treating those as expiry would
 * strand a live session behind a Reconnect button over a transient upstream
 * blip. GitHub answers a spent or revoked refresh token with an OAuth error in
 * the body - misleadingly blaming the client id and secret, neither of which
 * is at fault - and that is the case worth acting on.
 */
const isSpentSession = (error: Error): boolean => {
  const message = error.message.toLowerCase();
  if (/\b(429|500|502|503|504)\b/.test(message)) return false;
  return (
    message.includes('client_id') ||
    message.includes('client_secret') ||
    message.includes('bad_verification_code') ||
    message.includes('incorrect_client_credentials') ||
    message.includes('expired_token') ||
    message.includes('invalid_grant') ||
    message.includes('unauthorized')
  );
};

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
export const forceRefreshToken = async (
  options?: { evenIfExpired?: boolean }
): Promise<string | null> => {
  const authState = getAuthState();
  const githubAuth = getGitHubAuth();
  const logger = getLogger();

  if (!authState?.refreshToken || !githubAuth) {
    return null;
  }

  // Already known to be over, so an automatic refresh is just noise: the
  // periodic one runs every minute, and a revoked session produced thousands of
  // identical failures that way. A person pressing Reconnect is different -
  // they may have re-authorised it, and that is the one case worth a request.
  if (authState.expired && !options?.evenIfExpired) {
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

      // Retry a network blip; anything else is not fixed by trying again.
      if (!isNetworkError(lastError)) {
        logger?.error(`Failed to refresh token (not retrying): ${lastError.message}`);

        // Retrying cannot fix this one, so the session is over - and saying so
        // is the point. Leaving the auth state alone meant the app went on
        // reporting a signed-in account it could not act as: Settings showed
        // Sign Out, the CLI said "Connected as", heartbeats retried a dead
        // token every minute, and the only truthful message was a per-job
        // "cannot check policy: not authenticated". The login is kept so the
        // UI can offer to reconnect as the right person.
        // Only a definitive auth failure proves the session is over. A 429 or
        // a 5xx is not evidence of anything except a bad moment upstream.
        if (!isSpentSession(lastError)) return null;

        // The access token goes with it: getValidAccessToken looks at expiresAt,
        // which can still be in the future, and would hand out a dead token
        // while `expired` says the session is unusable.
        const expiredState = { ...getAuthState(), ...authState, expired: true, accessToken: undefined };
        setAuthState(expiredState);
        const config = loadConfig();
        config.auth = expiredState;
        saveConfig(config);
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

  return authState.accessToken ?? null;
};

/** Running job info for cancellation */
export interface RunningJob {
  githubRunId?: number;
  repository: string;  // "owner/repo" format
}

/**
 * Cancel workflow runs for jobs we're currently running.
 * Called on app quit to ensure clean shutdown - prevents orphaned jobs
 * that would block runner deletion on next startup.
 *
 * @param runningJobs - Jobs currently running (from job history with status='running')
 */
export const cancelJobsOnOurRunners = async (runningJobs: RunningJob[]): Promise<void> => {
  const logger = getLogger();
  const githubAuth = getGitHubAuth();

  logger?.info('cancelJobsOnOurRunners: Starting...');

  const accessToken = await getValidAccessToken();
  if (!accessToken || !githubAuth) {
    logger?.info('cancelJobsOnOurRunners: No access token, skipping');
    return;
  }

  // Filter to jobs with run IDs we can cancel
  const jobsToCancel = runningJobs.filter(j => j.githubRunId && j.repository);

  if (jobsToCancel.length === 0) {
    logger?.info('cancelJobsOnOurRunners: No running jobs with run IDs to cancel');
    return;
  }

  logger?.info(`Cancelling ${jobsToCancel.length} running job(s)...`);

  let cancelledCount = 0;

  for (const job of jobsToCancel) {
    const parts = job.repository.split('/');
    if (parts.length !== 2) {
      logger?.warn(`Invalid repository format: ${job.repository}`);
      continue;
    }
    const [owner, repo] = parts;

    try {
      logger?.info(`Cancelling workflow run ${job.githubRunId} in ${job.repository}`);
      await githubAuth.cancelWorkflowRun(accessToken, owner, repo, job.githubRunId!);
      cancelledCount++;
    } catch (err) {
      logger?.warn(`Failed to cancel run ${job.githubRunId}: ${(err as Error).message}`);
    }
  }

  if (cancelledCount > 0) {
    logger?.info(`Waiting for ${cancelledCount} cancellation(s) to be processed...`);
    await new Promise(resolve => setTimeout(resolve, 3000));
    logger?.info('Done waiting for cancellations');
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
