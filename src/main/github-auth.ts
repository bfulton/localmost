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
 * One segment of a REST path, encoded.
 *
 * Owner, repo and the rest reach this file from the CLI socket, IPC and job
 * payloads, and every request carries the user's token. Interpolated raw, a
 * "/" or "?" in a name would steer that request to another endpoint; encoded,
 * it stays one segment. A dot segment is refused outright, because the URL
 * parser collapses "." and ".." before the request is sent, encoded or not.
 */
function segment(value: string | number): string {
  const text = String(value);
  if (text === '' || text === '.' || text === '..') {
    throw new Error(`"${text}" is not a valid GitHub API path segment`);
  }
  return encodeURIComponent(text);
}

/** A value whose slashes are part of the path - a file path, a branch name - with each part encoded. */
const segments = (value: string): string => value.split('/').map(segment).join('/');

/**
 * The name an author with no linked GitHub account goes by in an author set.
 *
 * Such an author is whoever wrote the email into a commit - anyone who can
 * get one merged or pushed - so no allowlist may admit it. Logins are
 * alphanumerics and hyphens, so a parenthesised name with spaces can never
 * equal one, and since the admission refusal lists the authors it refused,
 * the name itself says why. `detail` (a commit, an email, a name) comes from
 * commit metadata, so control and format characters (a right-to-left
 * override, a zero-width space) are replaced, lest the reason read as
 * something else, and it is cut to 100 characters, not UTF-16 units, so the
 * cut never splits one.
 */
export function unattributedAuthor(detail: string): string {
  const shown = Array.from(detail.replace(/[\p{Cc}\p{Cf}]/gu, '?')).slice(0, 100).join('');
  return `(unattributed ${shown}: no linked GitHub account, so no allowlist can admit it)`;
}

/** Commits per page when listing or comparing commits (GitHub's maximum). */
const COMMIT_PAGE_SIZE = 100;

/**
 * The most commits an author check reads from one range or history. A longer
 * one is refused rather than read in part.
 */
const COMMIT_READ_LIMIT = 1000;

/** Entries per page of the repository activity API (GitHub's maximum). */
const ACTIVITY_PAGE_SIZE = 100;

/**
 * The most pages of branch activity read for one window. A branch updated
 * more often than that is refused rather than read in part.
 */
const ACTIVITY_PAGE_LIMIT = 10;

/** One update of a branch, from the repository activity API. */
export interface BranchUpdate {
  /** The branch's commit before the update; all zeros when it was created. */
  before: string;
  /** The branch's commit after the update; all zeros when it was deleted. */
  after: string;
  /** GitHub's activity_type: push, force_push, pr_merge, branch_creation, ... */
  type: string;
}

/** Whether `sha` is a full commit hash (SHA-1, or SHA-256 for such repositories), including all zeros. */
function isCommitSha(sha: unknown): sha is string {
  return typeof sha === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(sha);
}

/** Whether `sha` is the all-zeros hash GitHub reports for a side of an update that has no commit. */
export function isNullSha(sha: string): boolean {
  return /^0+$/.test(sha);
}

/**
 * The author a commit counts as: its linked account's login, lowercase.
 *
 * A commit with no linked account has an email that belongs to nobody GitHub
 * knows, which is anyone who can get a commit merged or pushed. Skipping it
 * read as "no new authors"; it stands in the set as unattributed, so no
 * allowlist admits it and the refusal says which commit.
 */
function commitAuthor(commit: { sha?: string; author: { login?: string } | null }): string {
  if (commit.author?.login) {
    return commit.author.login.toLowerCase();
  }
  return unattributedAuthor(commit.sha ? `commit ${commit.sha.slice(0, 7)}` : 'commit');
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
    const data = await client.post<{ token: string }>(`/repos/${segment(owner)}/${segment(repo)}/actions/runners/registration-token`);
    return data.token;
  }

  async getOrgRunnerRegistrationToken(accessToken: string, org: string): Promise<string> {
    const client = new GitHubClient(accessToken);
    const data = await client.post<{ token: string }>(`/orgs/${segment(org)}/actions/runners/registration-token`);
    return data.token;
  }

  async getRunnerRemoveToken(accessToken: string, owner: string, repo: string): Promise<string> {
    const client = new GitHubClient(accessToken);
    const data = await client.post<{ token: string }>(`/repos/${segment(owner)}/${segment(repo)}/actions/runners/remove-token`);
    return data.token;
  }

  async getOrgRunnerRemoveToken(accessToken: string, org: string): Promise<string> {
    const client = new GitHubClient(accessToken);
    const data = await client.post<{ token: string }>(`/orgs/${segment(org)}/actions/runners/remove-token`);
    return data.token;
  }

  /**
   * List all runners for a repository
   */
  async listRunners(accessToken: string, owner: string, repo: string): Promise<Array<{ id: number; name: string; status: string }>> {
    const client = new GitHubClient(accessToken);
    const data = await client.get<{ runners: Array<{ id: number; name: string; status: string }> }>(`/repos/${segment(owner)}/${segment(repo)}/actions/runners`);
    return data.runners || [];
  }

  /**
   * List all runners for an organization
   */
  async listOrgRunners(accessToken: string, org: string): Promise<Array<{ id: number; name: string; status: string }>> {
    const client = new GitHubClient(accessToken);
    const data = await client.get<{ runners: Array<{ id: number; name: string; status: string }> }>(`/orgs/${segment(org)}/actions/runners`);
    return data.runners || [];
  }

  /**
   * Delete a runner from a repository
   */
  async deleteRunner(accessToken: string, owner: string, repo: string, runnerId: number): Promise<void> {
    const client = new GitHubClient(accessToken);
    await client.delete(`/repos/${segment(owner)}/${segment(repo)}/actions/runners/${segment(runnerId)}`);
  }

  /**
   * Delete a runner from an organization
   */
  async deleteOrgRunner(accessToken: string, org: string, runnerId: number): Promise<void> {
    const client = new GitHubClient(accessToken);
    await client.delete(`/orgs/${segment(org)}/actions/runners/${segment(runnerId)}`);
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
    await client.post(`/repos/${segment(owner)}/${segment(repo)}/actions/runs/${segment(runId)}/cancel`, {});
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
      `/repos/${segment(owner)}/${segment(repo)}/actions/jobs/${segment(jobId)}`
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
        }>(`/user/installations/${segment(installation.id)}/repositories?per_page=100`);

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
      await client.patch(`/repos/${segment(owner)}/${segment(repo)}/actions/variables/${segment(name)}`, {
        name,
        value,
      });
    } catch (error) {
      // If variable doesn't exist (404), create it
      if ((error as { status?: number }).status === 404) {
        await client.post(`/repos/${segment(owner)}/${segment(repo)}/actions/variables`, {
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
      await client.patch(`/orgs/${segment(org)}/actions/variables/${segment(name)}`, {
        name,
        value,
        visibility,
      });
    } catch (error) {
      // If variable doesn't exist (404), create it
      if ((error as { status?: number }).status === 404) {
        await client.post(`/orgs/${segment(org)}/actions/variables`, {
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
          const userDetails = await client.get<{ name: string | null }>(`/users/${segment(user.login)}`);
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

    // anon=1, so authors with no linked account are listed too. anon=0 left
    // them out - and GitHub links only the first 500 author emails, so past
    // that it left out everyone - and the baseline read as trusted while code
    // nobody vouched for was already on the default branch. Each one stands in
    // the set as unattributed, which no allowlist admits: a repository with
    // such an author anywhere in its history is refused under 'contributors'.
    while (true) {
      const data = await client.get<Array<{ login?: string; email?: string; name?: string }>>(
        `/repos/${segment(owner)}/${segment(repo)}/contributors`,
        { params: { per_page: String(perPage), page: String(page), anon: '1' } }
      );

      if (!data || data.length === 0) {
        break;
      }

      for (const contributor of data) {
        if (contributor.login) {
          contributors.push(contributor.login.toLowerCase());
        } else {
          contributors.push(unattributedAuthor(contributor.email || contributor.name || 'contributor'));
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
   * Returns array of author logins for the commits in headSha that are not in
   * baseSha - with three dots, those after their merge base, so it also holds
   * when baseSha is not an ancestor of headSha, as after a force push.
   */
  async getCommitAuthors(
    accessToken: string,
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string
  ): Promise<string[]> {
    const client = new GitHubClient(accessToken);
    const authors = new Map<string, string>();

    try {
      // Called without paging parameters, compare returns at most 250
      // commits while still reporting the true total; with them, it pages
      // through all of them. The result gates job execution, so a range is
      // read in full or not at all: past COMMIT_READ_LIMIT, or if the pages
      // add up to less than the total, this throws.
      let total = 0;
      for (let page = 1; ; page++) {
        const data = await client.get<{
          total_commits: number;
          commits: Array<{
            sha: string;
            author: { login: string } | null;
          }>;
        }>(`/repos/${segment(owner)}/${segment(repo)}/compare/${segment(baseSha)}...${segment(headSha)}`, {
          params: { per_page: String(COMMIT_PAGE_SIZE), page: String(page) },
        });

        if (typeof data.total_commits !== 'number') {
          throw new Error('compare response has no commit count');
        }
        total = data.total_commits;
        if (total > COMMIT_READ_LIMIT) {
          throw new Error(
            `compare has ${total} commits, more than the ${COMMIT_READ_LIMIT} this check reads; author list would be incomplete`
          );
        }

        const commits = data.commits || [];
        for (const commit of commits) {
          authors.set(commit.sha, commitAuthor(commit));
        }
        if (
          authors.size >= total ||
          commits.length < COMMIT_PAGE_SIZE ||
          page * COMMIT_PAGE_SIZE >= COMMIT_READ_LIMIT
        ) {
          break;
        }
      }

      if (authors.size < total) {
        throw new Error(
          `compare returned ${authors.size} of ${total} commits; author list would be incomplete`
        );
      }
    } catch (error) {
      // Do not swallow this. An empty result is indistinguishable from "no new
      // authors", and callers use the author set to decide whether untrusted
      // contributors are involved in a job.
      throw new Error(
        `Failed to compare ${baseSha}...${headSha} for ${owner}/${repo}: ${(error as Error).message}`
      );
    }

    return Array.from(new Set(authors.values()));
  }

  /**
   * Authors of every commit reachable from `headSha`.
   *
   * For a branch created within the activity window, which has no earlier
   * commit to compare from: in practice a new repository's first push. Like
   * getCommitAuthors, a history longer than COMMIT_READ_LIMIT throws rather
   * than being read in part, and so does any failure.
   */
  async getHistoryAuthors(
    accessToken: string,
    owner: string,
    repo: string,
    headSha: string
  ): Promise<string[]> {
    const client = new GitHubClient(accessToken);
    const authors = new Set<string>();

    try {
      for (let page = 1; ; page++) {
        if ((page - 1) * COMMIT_PAGE_SIZE >= COMMIT_READ_LIMIT) {
          throw new Error(`history is longer than the ${COMMIT_READ_LIMIT} commits this check reads`);
        }
        const data = await client.get<Array<{ sha: string; author: { login?: string } | null }>>(
          `/repos/${segment(owner)}/${segment(repo)}/commits`,
          { params: { sha: headSha, per_page: String(COMMIT_PAGE_SIZE), page: String(page) } }
        );

        for (const commit of data || []) {
          authors.add(commitAuthor(commit));
        }
        if (!data || data.length < COMMIT_PAGE_SIZE) {
          break;
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to list the commits of ${headSha} for ${owner}/${repo}: ${(error as Error).message}`
      );
    }

    return Array.from(authors);
  }

  /**
   * Every update of `branch` GitHub recorded within `windowMs` before now -
   * pushes, force pushes, pull request and merge queue merges, creation and
   * deletion - from the repository activity API, newest first.
   *
   * The window is measured on GitHub's clocks: each entry's timestamp is when
   * GitHub recorded the update, and "now" is the Date header of the first
   * page, so neither a committer's dates nor this machine's clock moves it.
   * The result gates job execution, so anything that would leave the window
   * read in part throws: an API error, an entry for another ref, entries out
   * of order, a missing Date header, or more than ACTIVITY_PAGE_LIMIT pages.
   */
  async getRecentBranchUpdates(
    accessToken: string,
    owner: string,
    repo: string,
    branch: string,
    windowMs: number
  ): Promise<BranchUpdate[]> {
    const client = new GitHubClient(accessToken);
    const endpoint = `/repos/${segment(owner)}/${segment(repo)}/activity`;
    const ref = `refs/heads/${branch}`;
    const updates: BranchUpdate[] = [];

    try {
      let params: Record<string, string> = {
        ref,
        direction: 'desc',
        per_page: String(ACTIVITY_PAGE_SIZE),
      };
      let cutoff: number | undefined;
      let previous = Infinity;

      for (let page = 1; ; page++) {
        if (page > ACTIVITY_PAGE_LIMIT) {
          throw new Error(
            `more than ${ACTIVITY_PAGE_LIMIT * ACTIVITY_PAGE_SIZE} updates of ${branch} within the window`
          );
        }
        const { data, next, date } = await client.getPage<Array<{
          before: string;
          after: string;
          ref: string;
          timestamp: string;
          activity_type: string;
        }>>(endpoint, params);

        if (cutoff === undefined) {
          if (!date) {
            throw new Error('activity response has no Date header');
          }
          cutoff = date.getTime() - windowMs;
        }

        let reachedCutoff = false;
        for (const entry of data || []) {
          if (entry.ref !== ref && entry.ref !== branch) {
            throw new Error(`activity entry for ${entry.ref}, not ${ref}`);
          }
          const at = Date.parse(entry.timestamp);
          if (Number.isNaN(at) || at > previous) {
            throw new Error(`activity entry timestamp '${entry.timestamp}' is out of order`);
          }
          previous = at;
          if (at < cutoff) {
            reachedCutoff = true;
            break;
          }
          if (!isCommitSha(entry.before) || !isCommitSha(entry.after)) {
            throw new Error(`activity entry has no commit range: ${entry.before}...${entry.after}`);
          }
          updates.push({ before: entry.before, after: entry.after, type: entry.activity_type });
        }

        if (reachedCutoff || !next) {
          break;
        }
        params = next;
      }
    } catch (error) {
      throw new Error(
        `Failed to list recent updates of ${branch} for ${owner}/${repo}: ${(error as Error).message}`
      );
    }

    return updates;
  }

  /**
   * Read a file from a repository at a given ref.
   *
   * Returns null when the file does not exist, which is the common case: most
   * repositories have no .localmostrc. Other failures throw, so a policy that
   * exists but cannot be read is never silently treated as absent.
   */
  async getFileContent(
    accessToken: string,
    owner: string,
    repo: string,
    filePath: string,
    ref: string
  ): Promise<string | null> {
    const client = new GitHubClient(accessToken);

    try {
      const data = await client.get<{ content?: string; encoding?: string }>(
        `/repos/${segment(owner)}/${segment(repo)}/contents/${segments(filePath)}`,
        { params: { ref } }
      );

      if (!data.content) {
        return null;
      }
      if (data.encoding && data.encoding !== 'base64') {
        throw new Error(`Unexpected encoding '${data.encoding}' for ${filePath}`);
      }
      return Buffer.from(data.content, 'base64').toString('utf-8');
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        return null;
      }
      throw error;
    }
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
      `/repos/${segment(owner)}/${segment(repo)}`
    );

    // Get the branch to find HEAD SHA
    const branchData = await client.get<{ commit: { sha: string } }>(
      `/repos/${segment(owner)}/${segment(repo)}/branches/${segments(repoData.default_branch)}`
    );

    return {
      name: repoData.default_branch,
      sha: branchData.commit.sha,
    };
  }
}
