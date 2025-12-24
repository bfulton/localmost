import { shell } from 'electron';
import { DEFAULT_GITHUB_CLIENT_ID } from '../shared/constants';
import { GitHubClient, githubOAuthRequest } from './github-client';

// Re-export for backward compatibility
export const DEFAULT_CLIENT_ID = DEFAULT_GITHUB_CLIENT_ID;

/**
 * Rate limiting configuration for OAuth device flow polling.
 * These limits prevent abuse and ensure compliance with GitHub's API guidelines.
 */
const POLLING_RATE_LIMITS = {
  /** Maximum number of polling attempts before giving up */
  MAX_ATTEMPTS: 60,
  /** Minimum interval between requests in milliseconds (GitHub requires >= 5s) */
  MIN_INTERVAL_MS: 5000,
  /** Maximum interval between requests in milliseconds (cap for backoff) */
  MAX_INTERVAL_MS: 30000,
  /** Multiplier for exponential backoff (1.1 = 10% increase per attempt) */
  BACKOFF_MULTIPLIER: 1.1,
  /** Additional delay in milliseconds when GitHub returns slow_down error */
  SLOW_DOWN_PENALTY_MS: 5000,
} as const;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

export interface GitHubUser {
  login: string;
  avatar_url: string;
  name: string | null;
}

export interface DeviceFlowStatus {
  userCode: string;
  verificationUri: string;
}

export interface AuthResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;  // Unix timestamp (ms) when access token expires
  user: GitHubUser;
}

export class GitHubAuth {
  private clientId: string;
  private pollingAborted = false;

  constructor(clientId: string = DEFAULT_CLIENT_ID) {
    this.clientId = clientId;
  }

  /**
   * Start Device Flow authentication
   * Returns the user code and verification URL for the user to complete auth
   */
  async startDeviceFlow(): Promise<{ status: DeviceFlowStatus; waitForAuth: () => Promise<AuthResult> }> {
    const response = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: this.clientId,
        // Scopes needed:
        // - repo: manage self-hosted runners, access private repos
        // - workflow: cancel workflow runs during cleanup
        scope: 'repo workflow',
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to start device flow: ${response.status}`);
    }

    const data: DeviceCodeResponse = await response.json();

    const status: DeviceFlowStatus = {
      userCode: data.user_code,
      verificationUri: data.verification_uri,
    };

    // Return both the status and a function to wait for auth completion
    return {
      status,
      waitForAuth: () => this.pollForToken(data),
    };
  }

  /**
   * Open the verification URL in the user's browser
   */
  openVerificationUrl(url: string): void {
    shell.openExternal(url);
  }

  /**
   * Abort any ongoing polling
   */
  abortPolling(): void {
    this.pollingAborted = true;
  }

  private async pollForToken(deviceCode: DeviceCodeResponse): Promise<AuthResult> {
    this.pollingAborted = false;
    const expiresAt = Date.now() + deviceCode.expires_in * 1000;

    // Initialize interval respecting GitHub's minimum and the server-provided value
    let currentInterval = Math.max(
      (deviceCode.interval || 5) * 1000,
      POLLING_RATE_LIMITS.MIN_INTERVAL_MS
    );
    let attempts = 0;

    while (Date.now() < expiresAt && !this.pollingAborted) {
      // Rate limit enforcement: hard cap on polling attempts
      if (attempts >= POLLING_RATE_LIMITS.MAX_ATTEMPTS) {
        // Rate limit reached - user will need to retry auth flow
        throw new Error('Authentication failed: maximum polling attempts exceeded. Please try again.');
      }

      await this.sleep(currentInterval);
      attempts++;

      if (this.pollingAborted) {
        throw new Error('Authentication cancelled');
      }

      try {
        const response = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            client_id: this.clientId,
            device_code: deviceCode.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        });

        const data = await response.json();

        if (data.error) {
          if (data.error === 'authorization_pending') {
            // User hasn't completed auth yet, apply exponential backoff and continue
            currentInterval = Math.min(
              currentInterval * POLLING_RATE_LIMITS.BACKOFF_MULTIPLIER,
              POLLING_RATE_LIMITS.MAX_INTERVAL_MS
            );
            continue;
          } else if (data.error === 'slow_down') {
            // GitHub is asking us to slow down - apply penalty and increase backoff
            // GitHub requested slower polling - increase interval
            currentInterval = Math.min(
              currentInterval + POLLING_RATE_LIMITS.SLOW_DOWN_PENALTY_MS,
              POLLING_RATE_LIMITS.MAX_INTERVAL_MS
            );
            continue;
          } else if (data.error === 'expired_token') {
            throw new Error('Authentication timed out. Please try again.');
          } else if (data.error === 'access_denied') {
            throw new Error('Access denied. User cancelled authorization.');
          } else {
            throw new Error(data.error_description || data.error);
          }
        }

        if (data.access_token) {
          // Success! Get user info
          const user = await this.fetchUser(data.access_token);
          const result: AuthResult = {
            accessToken: data.access_token,
            user,
          };

          // GitHub App tokens include refresh token and expiration
          if (data.refresh_token) {
            result.refreshToken = data.refresh_token;
          }
          if (data.expires_in) {
            // Calculate expiration timestamp, subtract 5 minutes for safety margin
            result.expiresAt = Date.now() + (data.expires_in - 300) * 1000;
          }

          return result;
        }
      } catch (error) {
        if ((error as Error).message.includes('cancelled') ||
            (error as Error).message.includes('denied') ||
            (error as Error).message.includes('timed out') ||
            (error as Error).message.includes('maximum polling attempts')) {
          throw error;
        }
        // Network error - apply backoff but keep trying
        // Common causes: DNS, connectivity, GitHub API outage
        currentInterval = Math.min(
          currentInterval * POLLING_RATE_LIMITS.BACKOFF_MULTIPLIER,
          POLLING_RATE_LIMITS.MAX_INTERVAL_MS
        );
      }
    }

    if (this.pollingAborted) {
      throw new Error('Authentication cancelled');
    }

    throw new Error('Authentication timed out');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async fetchUser(accessToken: string): Promise<GitHubUser> {
    const client = new GitHubClient(accessToken);
    return client.get<GitHubUser>('/user');
  }

  /**
   * Refresh an expired access token using the refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<AuthResult> {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: this.clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to refresh token: ${response.status}`);
    }

    // GitHub OAuth returns errors as 200 OK with error field in JSON body
    const data = await response.json() as GitHubTokenResponse & { error?: string; error_description?: string };

    // Check for OAuth error response
    if (data.error) {
      throw new Error(`Failed to refresh token: ${data.error_description || data.error}`);
    }

    if (!data.access_token) {
      throw new Error('Failed to refresh token: no access token returned');
    }

    const user = await this.fetchUser(data.access_token);
    const result: AuthResult = {
      accessToken: data.access_token,
      user,
    };

    if (data.refresh_token) {
      result.refreshToken = data.refresh_token;
    }
    if (data.expires_in) {
      result.expiresAt = Date.now() + (data.expires_in - 300) * 1000;
    }

    return result;
  }

  /**
   * Check if an access token is expired or about to expire
   */
  isTokenExpired(expiresAt?: number): boolean {
    if (!expiresAt) {
      // No expiration info, assume it's still valid (legacy OAuth App tokens don't expire)
      return false;
    }
    return Date.now() >= expiresAt;
  }

  async getRunnerRegistrationToken(accessToken: string, owner: string, repo: string): Promise<string> {
    const client = new GitHubClient(accessToken);
    const data = await client.post<{ token: string }>(`/repos/${owner}/${repo}/actions/runners/registration-token`);
    return data.token;
  }

  async getOrgRunnerRegistrationToken(accessToken: string, org: string): Promise<string> {
    const client = new GitHubClient(accessToken);
    const data = await client.post<{ token: string }>(`/orgs/${org}/actions/runners/registration-token`);
    return data.token;
  }

  async getRunnerRemoveToken(accessToken: string, owner: string, repo: string): Promise<string> {
    const client = new GitHubClient(accessToken);
    const data = await client.post<{ token: string }>(`/repos/${owner}/${repo}/actions/runners/remove-token`);
    return data.token;
  }

  async getOrgRunnerRemoveToken(accessToken: string, org: string): Promise<string> {
    const client = new GitHubClient(accessToken);
    const data = await client.post<{ token: string }>(`/orgs/${org}/actions/runners/remove-token`);
    return data.token;
  }

  /**
   * List all runners for a repository
   */
  async listRunners(accessToken: string, owner: string, repo: string): Promise<Array<{ id: number; name: string; status: string }>> {
    const client = new GitHubClient(accessToken);
    const data = await client.get<{ runners: Array<{ id: number; name: string; status: string }> }>(`/repos/${owner}/${repo}/actions/runners`);
    return data.runners || [];
  }

  /**
   * List all runners for an organization
   */
  async listOrgRunners(accessToken: string, org: string): Promise<Array<{ id: number; name: string; status: string }>> {
    const client = new GitHubClient(accessToken);
    const data = await client.get<{ runners: Array<{ id: number; name: string; status: string }> }>(`/orgs/${org}/actions/runners`);
    return data.runners || [];
  }

  /**
   * Delete a runner from a repository
   */
  async deleteRunner(accessToken: string, owner: string, repo: string, runnerId: number): Promise<void> {
    const client = new GitHubClient(accessToken);
    await client.delete(`/repos/${owner}/${repo}/actions/runners/${runnerId}`);
  }

  /**
   * Delete a runner from an organization
   */
  async deleteOrgRunner(accessToken: string, org: string, runnerId: number): Promise<void> {
    const client = new GitHubClient(accessToken);
    await client.delete(`/orgs/${org}/actions/runners/${runnerId}`);
  }

  /**
   * Get recent workflow runs for a repository (in_progress runs first)
   */
  async getRecentWorkflowRuns(
    accessToken: string,
    owner: string,
    repo: string
  ): Promise<Array<{ id: number; name: string; status: string; created_at: string; actor: { login: string } }>> {
    const client = new GitHubClient(accessToken);
    const data = await client.get<{ workflow_runs: Array<{ id: number; name: string; status: string; created_at: string; actor: { login: string } }> }>(
      `/repos/${owner}/${repo}/actions/runs`,
      { params: { per_page: '10', status: 'in_progress' } }
    );
    return (data.workflow_runs || []).map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      created_at: run.created_at,
      actor: { login: run.actor?.login || 'unknown' },
    }));
  }

  /**
   * Get jobs for a specific workflow run
   */
  async getWorkflowRunJobs(
    accessToken: string,
    owner: string,
    repo: string,
    runId: number
  ): Promise<Array<{ id: number; name: string; status: string; html_url: string; runner_name: string | null }>> {
    const client = new GitHubClient(accessToken);
    const data = await client.get<{ jobs: Array<{ id: number; name: string; status: string; html_url: string; runner_name: string | null }> }>(
      `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`
    );
    return (data.jobs || []).map((job) => ({
      id: job.id,
      name: job.name,
      status: job.status,
      html_url: job.html_url,
      runner_name: job.runner_name,
    }));
  }

  /**
   * Cancel a workflow run
   */
  async cancelWorkflowRun(
    accessToken: string,
    owner: string,
    repo: string,
    runId: number
  ): Promise<void> {
    const client = new GitHubClient(accessToken);
    await client.post(`/repos/${owner}/${repo}/actions/runs/${runId}/cancel`, {});
  }

  /**
   * Get GitHub App installations accessible to the user.
   * Returns orgs and user accounts where the app is installed.
   */
  async getInstallations(accessToken: string): Promise<Array<{
    id: number;
    account: {
      login: string;
      id: number;
      avatar_url: string;
      type: 'User' | 'Organization';
    };
  }>> {
    const client = new GitHubClient(accessToken);
    const data = await client.get<{ installations: Array<{ id: number; account: { login: string; id: number; avatar_url: string; type: 'User' | 'Organization' } }> }>(
      '/user/installations'
    );
    return data.installations || [];
  }

  /**
   * Get organizations where the GitHub App is installed and accessible to the user.
   */
  async getInstalledOrgs(accessToken: string): Promise<Array<{
    id: number;
    login: string;
    avatar_url: string;
  }>> {
    const installations = await this.getInstallations(accessToken);
    return installations
      .filter(inst => inst.account.type === 'Organization')
      .map(inst => ({
        id: inst.account.id,
        login: inst.account.login,
        avatar_url: inst.account.avatar_url,
      }));
  }

  /**
   * Get repositories where the GitHub App is installed.
   * This returns only repos the App has access to, not all user repos.
   */
  async getInstalledRepos(accessToken: string): Promise<Array<{
    id: number;
    name: string;
    full_name: string;
    owner: { login: string; avatar_url: string };
    private: boolean;
    html_url: string;
  }>> {
    const installations = await this.getInstallations(accessToken);
    const client = new GitHubClient(accessToken);
    const allRepos: Array<{
      id: number;
      name: string;
      full_name: string;
      owner: { login: string; avatar_url: string };
      private: boolean;
      html_url: string;
    }> = [];

    // Fetch repos from each installation
    for (const installation of installations) {
      try {
        const data = await client.get<{
          repositories: Array<{
            id: number;
            name: string;
            full_name: string;
            owner: { login: string; avatar_url: string };
            private: boolean;
            html_url: string;
          }>;
        }>(`/user/installations/${installation.id}/repositories?per_page=100`);

        if (data.repositories) {
          allRepos.push(...data.repositories);
        }
      } catch (error) {
        // Log but continue - one installation failing shouldn't break all
        console.error(`Failed to fetch repos for installation ${installation.id}: ${(error as Error).message}`);
      }
    }

    return allRepos;
  }

  /**
   * Create or update a repository variable.
   * Variables are plaintext and readable in workflows without special permissions.
   */
  async setRepoVariable(
    accessToken: string,
    owner: string,
    repo: string,
    name: string,
    value: string
  ): Promise<void> {
    const client = new GitHubClient(accessToken);
    try {
      // Try to update existing variable
      await client.patch(`/repos/${owner}/${repo}/actions/variables/${name}`, {
        name,
        value,
      });
    } catch (error) {
      // If variable doesn't exist (404), create it
      if ((error as any).status === 404) {
        await client.post(`/repos/${owner}/${repo}/actions/variables`, {
          name,
          value,
        });
      } else {
        throw error;
      }
    }
  }

  /**
   * Create or update an organization variable.
   * Variables are plaintext and readable in workflows without special permissions.
   */
  async setOrgVariable(
    accessToken: string,
    org: string,
    name: string,
    value: string,
    visibility: 'all' | 'private' | 'selected' = 'all'
  ): Promise<void> {
    const client = new GitHubClient(accessToken);
    try {
      // Try to update existing variable
      await client.patch(`/orgs/${org}/actions/variables/${name}`, {
        name,
        value,
        visibility,
      });
    } catch (error) {
      // If variable doesn't exist (404), create it
      if ((error as any).status === 404) {
        await client.post(`/orgs/${org}/actions/variables`, {
          name,
          value,
          visibility,
        });
      } else {
        throw error;
      }
    }
  }

  /**
   * Search for GitHub users by username.
   * Returns up to 10 users matching the query.
   */
  async searchUsers(
    accessToken: string,
    query: string
  ): Promise<Array<{ login: string; avatar_url: string; name: string | null }>> {
    if (!query || query.trim().length === 0) {
      return [];
    }

    const client = new GitHubClient(accessToken);
    const data = await client.get<{
      items: Array<{ login: string; avatar_url: string }>;
    }>('/search/users', {
      params: {
        q: query,
        per_page: '10',
      },
    });

    // GitHub search API doesn't return the name field, so we need to fetch each user
    // To avoid rate limiting, we only fetch details for the first 5 results
    const usersWithNames = await Promise.all(
      (data.items || []).slice(0, 5).map(async (user) => {
        try {
          const userDetails = await client.get<{ name: string | null }>(`/users/${user.login}`);
          return {
            login: user.login,
            avatar_url: user.avatar_url,
            name: userDetails.name,
          };
        } catch {
          return {
            login: user.login,
            avatar_url: user.avatar_url,
            name: null,
          };
        }
      })
    );

    return usersWithNames;
  }
}
