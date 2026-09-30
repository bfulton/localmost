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

/**
 * `.` and `..` match the character class but are not names; GitHub refuses
 * them. It also strips a trailing `.git` from any name it is given, so no
 * repository's name ends in one, and on the end of a URL it is only ever the
 * clone suffix.
 */
export const isGitHubRepoName = (value: unknown): value is string =>
  typeof value === 'string' &&
  REPO_NAME.test(value) &&
  value !== '.' &&
  value !== '..' &&
  !value.endsWith('.git');

/**
 * A login as a user filter compares it: any login GitHub has issued. Older
 * accounts can hold one the owner rule refuses, such as a trailing or doubled
 * hyphen, and a saved allowlist must keep them. Letters, digits, `-` and `_`
 * still cannot carry a path, a query or a dot segment.
 */
const LOGIN = /^[A-Za-z0-9_-]+$/;

export const isGitHubLogin = (value: unknown): value is string =>
  typeof value === 'string' && LOGIN.test(value);

/**
 * The owner and repo of a repository page, `https://github.com/<owner>/<repo>`,
 * as the setup wizard offers it (GitHub's `html_url`) and every saved
 * runnerConfig.repoUrl holds it; null for anything else. The clone suffix and
 * a trailing slash are taken off, as a pasted link has them. The whole string
 * is matched, so a URL naming another host - or naming github.com anywhere
 * but at its start - names no repository. A repo name keeps its dots: only a
 * final `.git` is the suffix, and no name GitHub keeps ends in one.
 */
export const parseGitHubRepoUrl = (value: unknown): { owner: string; repo: string } | null =>
  parseRepoUrl(value, isGitHubOwnerName);

/**
 * The same, for a URL a config has already saved: its owner may be any login
 * GitHub has issued. The setup wizard saved an older account's html_url as it
 * was, trailing or doubled hyphen and all, and a runner saved before targets
 * re-registers from it. A login still cannot carry a path, a query or a dot.
 */
export const parseSavedGitHubRepoUrl = (value: unknown): { owner: string; repo: string } | null =>
  parseRepoUrl(value, isGitHubLogin);

const parseRepoUrl = (
  value: unknown,
  isOwner: (name: string) => boolean
): { owner: string; repo: string } | null => {
  if (typeof value !== 'string') return null;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(value);
  if (!match || !isOwner(match[1]) || !isGitHubRepoName(match[2])) return null;
  return { owner: match[1], repo: match[2] };
};
