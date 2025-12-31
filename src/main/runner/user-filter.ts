/**
 * User Filter
 *
 * Handles user filtering for job acceptance.
 *
 * Two-dimensional model:
 * - scope: What to check (everyone, trigger author, or all contributors)
 * - allowedUsers: Who is allowed (just me, or explicit allowlist)
 *
 * Also supports legacy 'mode' field for backwards compatibility.
 */

import type { UserFilterConfig, FilterScope, AllowedUsers } from '../../shared/types';

/**
 * Normalize a filter config, handling legacy 'mode' field.
 * Returns the effective scope and allowedUsers.
 */
export function normalizeFilterConfig(
  userFilter: UserFilterConfig | undefined
): { scope: FilterScope; allowedUsers: AllowedUsers; allowlist: string[] } {
  if (!userFilter) {
    return { scope: 'everyone', allowedUsers: 'just-me', allowlist: [] };
  }

  // Handle new format
  if (userFilter.scope) {
    return {
      scope: userFilter.scope,
      allowedUsers: userFilter.allowedUsers || 'just-me',
      allowlist: (userFilter.allowlist || []).map(u => u.login.toLowerCase()),
    };
  }

  // Handle legacy 'mode' field
  if (userFilter.mode) {
    switch (userFilter.mode) {
      case 'everyone':
        return { scope: 'everyone', allowedUsers: 'just-me', allowlist: [] };
      case 'just-me':
        return { scope: 'trigger', allowedUsers: 'just-me', allowlist: [] };
      case 'allowlist':
        return {
          scope: 'trigger',
          allowedUsers: 'allowlist',
          allowlist: (userFilter.allowlist || []).map(u => u.login.toLowerCase()),
        };
    }
  }

  return { scope: 'everyone', allowedUsers: 'just-me', allowlist: [] };
}

/**
 * Check if a single user is allowed based on filter configuration.
 * Used for 'trigger' scope to check the workflow trigger.
 */
export function isUserAllowed(
  login: string,
  userFilter: UserFilterConfig | undefined,
  currentUserLogin: string | undefined
): boolean {
  const { scope, allowedUsers, allowlist } = normalizeFilterConfig(userFilter);

  // Everyone scope - allow all
  if (scope === 'everyone') {
    return true;
  }

  // Check the user against allowedUsers setting
  return isLoginAllowed(login, allowedUsers, allowlist, currentUserLogin);
}

/**
 * Check if ALL users in a set are allowed.
 * Used for 'contributors' scope to check all repo contributors.
 */
export function areAllUsersAllowed(
  logins: Set<string>,
  userFilter: UserFilterConfig | undefined,
  currentUserLogin: string | undefined
): { allowed: boolean; disallowedUsers: string[] } {
  const { scope, allowedUsers, allowlist } = normalizeFilterConfig(userFilter);

  // Everyone scope - allow all
  if (scope === 'everyone') {
    return { allowed: true, disallowedUsers: [] };
  }

  const disallowedUsers: string[] = [];

  for (const login of logins) {
    if (!isLoginAllowed(login, allowedUsers, allowlist, currentUserLogin)) {
      disallowedUsers.push(login);
    }
  }

  return {
    allowed: disallowedUsers.length === 0,
    disallowedUsers,
  };
}

/**
 * Check if a login is allowed by the allowedUsers setting.
 */
function isLoginAllowed(
  login: string,
  allowedUsers: AllowedUsers,
  allowlist: string[],
  currentUserLogin: string | undefined
): boolean {
  const loginLower = login.toLowerCase();

  if (allowedUsers === 'just-me') {
    // If we don't know who we are, allow (fail open)
    if (!currentUserLogin) return true;
    return loginLower === currentUserLogin.toLowerCase();
  }

  if (allowedUsers === 'allowlist') {
    // Check if user is in the allowlist
    // Also include current user automatically
    if (currentUserLogin && loginLower === currentUserLogin.toLowerCase()) {
      return true;
    }
    return allowlist.includes(loginLower);
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
    const { scope } = normalizeFilterConfig(userFilter);

    // No filtering in everyone scope
    if (scope === 'everyone') {
      return true;
    }

    if (!this.isAllowed(actorLogin)) {
      log(`Job from ${actorLogin} not allowed by filter (scope: ${scope}), cancelling...`);

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
