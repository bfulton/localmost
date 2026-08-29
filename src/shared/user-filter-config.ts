/**
 * User filter config normalization.
 *
 * Shared by the main process (which enforces the filter) and the renderer
 * (which displays and edits it). Keeping one implementation avoids the two
 * drifting apart, which would let the UI show a different policy from the one
 * actually being enforced.
 */

import type { UserFilterConfig, FilterScope, AllowedUsers, AllowlistUser } from './types';

const FILTER_SCOPES: FilterScope[] = ['everyone', 'trigger', 'contributors'];
const ALLOWED_USERS: AllowedUsers[] = ['just-me', 'allowlist'];

export function isFilterScope(value: unknown): value is FilterScope {
  return FILTER_SCOPES.includes(value as FilterScope);
}

export function isAllowedUsers(value: unknown): value is AllowedUsers {
  return ALLOWED_USERS.includes(value as AllowedUsers);
}

function normalizeAllowlist(value: unknown): AllowlistUser[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (u): u is AllowlistUser =>
      !!u && typeof u === 'object' && typeof (u as AllowlistUser).login === 'string'
  );
}

/**
 * Resolve a stored filter config into a complete, valid one.
 *
 * Handles the legacy `mode` field, and treats any unrecognized value as the
 * restrictive option: this decides whether someone else's code may run on this
 * machine, so an unknown string must never widen access.
 */
export function normalizeUserFilterConfig(
  userFilter: UserFilterConfig | undefined
): { scope: FilterScope; allowedUsers: AllowedUsers; allowlist: AllowlistUser[] } {
  if (!userFilter) {
    return { scope: 'everyone', allowedUsers: 'just-me', allowlist: [] };
  }

  const allowlist = normalizeAllowlist(userFilter.allowlist);

  if (userFilter.scope !== undefined) {
    return {
      scope: isFilterScope(userFilter.scope) ? userFilter.scope : 'trigger',
      allowedUsers: isAllowedUsers(userFilter.allowedUsers) ? userFilter.allowedUsers : 'just-me',
      allowlist,
    };
  }

  switch (userFilter.mode) {
    case 'everyone':
      return { scope: 'everyone', allowedUsers: 'just-me', allowlist: [] };
    case 'just-me':
      return { scope: 'trigger', allowedUsers: 'just-me', allowlist: [] };
    case 'allowlist':
      return { scope: 'trigger', allowedUsers: 'allowlist', allowlist };
    default:
      return { scope: 'everyone', allowedUsers: 'just-me', allowlist: [] };
  }
}
