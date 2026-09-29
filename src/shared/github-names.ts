/**
 * The shapes GitHub allows for account and repository names.
 *
 * A target's owner and repo arrive from the CLI socket and from the renderer,
 * and end up in REST paths requested with the user's token and in URLs handed
 * to config.sh. Checking them against what GitHub itself accepts, where they
 * enter, keeps a name from ever carrying a path of its own.
 */

/**
 * A user or organization login: letters, digits and single inner hyphens.
 * Underscore is admitted inside a name too, because a managed (EMU) user's
 * login is `handle_shortcode` and can own repositories.
 */
const OWNER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;

/** A repository name: letters, digits, `_`, `.` and `-`. */
const REPO_NAME = /^[A-Za-z0-9_.-]+$/;

export const isGitHubOwnerName = (value: unknown): value is string =>
  typeof value === 'string' && OWNER_NAME.test(value);

/** `.` and `..` match the character class but are not names; GitHub refuses them. */
export const isGitHubRepoName = (value: unknown): value is string =>
  typeof value === 'string' && REPO_NAME.test(value) && value !== '.' && value !== '..';
