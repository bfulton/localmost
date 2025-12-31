import { shell } from 'electron';
import { DEFAULT_GITHUB_CLIENT_ID } from '../shared/constants';
import { GitHubClient } from './github-client';

// Re-export for backward compatibility
export const DEFAULT_CLIENT_ID = DEFAULT_GITHUB_CLIENT_ID;

/**
 * Validate that a URL is a legitimate GitHub URL before opening externally.
 * This prevents phishing attacks if the GitHub API were compromised.
 */
function isValidGitHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com';
  } catch {
    return false;
  }
}

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
   * Open the verification URL in the user's browser.
   * Validates the URL is actually GitHub before opening.
   */
  openVerificationUrl(url: string): void {
    if (isValidGitHubUrl(url)) {
      shell.openExternal(url);
    } else {
      throw new Error(`Refusing to open suspicious verification URL: ${url}`);
    }
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
   * Get job conclusion from GitHub API
   */
  async getJobConclusion(
    accessToken: string,
    owner: string,
    repo: string,
    jobId: number
  ): Promise<string | null> {
    const client = new GitHubClient(accessToken);
    const data = await client.get<{ conclusion: string | null }>(
      `/repos/${owner}/${repo}/actions/jobs/${jobId}`
    );
    return data.conclusion;
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
      if ((error as { status?: number }).status === 404) {
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
      if ((error as { status?: number }).status === 404) {
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

  /**
   * Get all contributors for a repository.
   * Returns array of contributor logins (paginated).
   */
  async getContributors(
    accessToken: string,
    owner: string,
    repo: string
  ): Promise<string[]> {
    const client = new GitHubClient(accessToken);
    const contributors: string[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const data = await client.get<Array<{ login: string }>>(
        `/repos/${owner}/${repo}/contributors`,
        { params: { per_page: String(perPage), page: String(page), anon: '0' } }
      );

      if (!data || data.length === 0) {
        break;
      }

      for (const contributor of data) {
        if (contributor.login) {
          contributors.push(contributor.login.toLowerCase());
        }
      }

      if (data.length < perPage) {
        break;
      }
      page++;
    }

    return contributors;
  }

  /**
   * Get commit authors between two SHAs.
   * Returns array of author logins for commits from baseSha to headSha.
   */
  async getCommitAuthors(
    accessToken: string,
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string
  ): Promise<string[]> {
    const client = new GitHubClient(accessToken);
    const authors = new Set<string>();

    try {
      // Use compare API to get commits between two refs
      const data = await client.get<{
        commits: Array<{
          author: { login: string } | null;
          commit: { author: { name: string } | null };
        }>;
      }>(`/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`);

      for (const commit of data.commits || []) {
        // Prefer the GitHub user login if available
        if (commit.author?.login) {
          authors.add(commit.author.login.toLowerCase());
        }
      }
    } catch (error) {
      // If compare fails (e.g., baseSha not found), return empty
      // This can happen if the repo was force-pushed
      console.error(`Failed to get commit authors: ${(error as Error).message}`);
    }

    return Array.from(authors);
  }

  /**
   * Get default branch info for a repository.
   * Returns the branch name and current HEAD SHA.
   */
  async getDefaultBranch(
    accessToken: string,
    owner: string,
    repo: string
  ): Promise<{ name: string; sha: string }> {
    const client = new GitHubClient(accessToken);

    // Get repo info to find default branch name
    const repoData = await client.get<{ default_branch: string }>(
      `/repos/${owner}/${repo}`
    );

    // Get the branch to find HEAD SHA
    const branchData = await client.get<{ commit: { sha: string } }>(
      `/repos/${owner}/${repo}/branches/${repoData.default_branch}`
    );

    return {
      name: repoData.default_branch,
      sha: branchData.commit.sha,
    };
  }
}
