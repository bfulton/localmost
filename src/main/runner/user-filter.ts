/**
 * User Filter
 *
 * Handles user filtering for job acceptance.
 * Supports everyone, just-me, and allowlist modes.
 */

import type { UserFilterConfig } from '../../shared/types';

/**
 * Check if a user is allowed based on filter configuration.
 */
export function isUserAllowed(
  actorLogin: string,
  userFilter: UserFilterConfig | undefined,
  currentUserLogin: string | undefined
): boolean {
  // No filter or everyone mode - allow all
  if (!userFilter || userFilter.mode === 'everyone') {
    return true;
  }

  // Just-me mode - only allow current user
  if (userFilter.mode === 'just-me') {
    // If we don't know who we are, allow (fail open)
    if (!currentUserLogin) return true;
    return actorLogin.toLowerCase() === currentUserLogin.toLowerCase();
  }

  // Allowlist mode - check if user is in list
  if (userFilter.mode === 'allowlist') {
    const allowlist = userFilter.allowlist ?? [];
    return allowlist.some(allowed =>
      allowed.toLowerCase() === actorLogin.toLowerCase()
    );
  }

  return true;
}

/**
 * Parse a repository string into owner and repo.
 * Handles formats like "owner/repo" and full GitHub URLs.
 */
export function parseRepository(repository: string): { owner: string; repo: string } | null {
  // Handle "owner/repo" format
  const parts = repository.split('/');
  if (parts.length === 2) {
    return { owner: parts[0], repo: parts[1] };
  }

  // Handle full GitHub URL
  const match = repository.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }

  return null;
}

/**
 * Filter configuration for users.
 */
export interface UserFilterOptions {
  getFilter: () => UserFilterConfig | undefined;
  getCurrentUser: () => string | undefined;
  onCancel?: (owner: string, repo: string, runId: number) => Promise<void>;
}

/**
 * User filter manager for enforcing user restrictions.
 */
export class UserFilterManager {
  private getFilter: () => UserFilterConfig | undefined;
  private getCurrentUser: () => string | undefined;
  private onCancel?: (owner: string, repo: string, runId: number) => Promise<void>;

  constructor(options: UserFilterOptions) {
    this.getFilter = options.getFilter;
    this.getCurrentUser = options.getCurrentUser;
    this.onCancel = options.onCancel;
  }

  /**
   * Check if a user is allowed.
   */
  isAllowed(actorLogin: string): boolean {
    return isUserAllowed(actorLogin, this.getFilter(), this.getCurrentUser());
  }

  /**
   * Enforce user filter on a job.
   * Returns true if job should proceed, false if cancelled.
   */
  async enforceFilter(
    actorLogin: string | undefined,
    githubRunId: number | undefined,
    repository: string | undefined,
    log: (message: string) => void
  ): Promise<boolean> {
    // Can't filter without actor info
    if (!actorLogin || !githubRunId || !repository) {
      return true;
    }

    const userFilter = this.getFilter();

    // No filtering in everyone mode
    if (!userFilter || userFilter.mode === 'everyone') {
      return true;
    }

    if (!this.isAllowed(actorLogin)) {
      log(`Job from ${actorLogin} not allowed by filter (mode: ${userFilter.mode}), cancelling...`);

      const repoInfo = parseRepository(repository);
      if (!repoInfo) {
        log(`Could not parse repository: ${repository}`);
        return false;
      }

      if (this.onCancel) {
        try {
          await this.onCancel(repoInfo.owner, repoInfo.repo, githubRunId);
          log(`Cancelled workflow run ${githubRunId} for ${actorLogin}`);
        } catch (err) {
          log(`Failed to cancel workflow: ${(err as Error).message}`);
        }
      }

      return false;
    }

    return true;
  }
}
