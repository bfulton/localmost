/**
 * Contributor Cache
 *
 * Caches repository contributors to efficiently check if all code authors
 * are trusted. Uses SHA-based cache invalidation instead of TTL:
 * - Store, with the default branch SHA when fetched, the contributor list and
 *   the authors of every default-branch update GitHub recorded in the last
 *   day, which covers the list's lag
 * - On subsequent checks, fetch commits since that SHA and add their authors
 * - This is deterministic and never stale
 */

import { GitHubAuth, isNullSha } from './github-auth';

/** Cache entry for a repository */
interface RepoCacheEntry {
  /** Set of contributor logins (lowercase) */
  contributors: Set<string>;
  /** SHA of default branch when contributors were fetched */
  defaultBranchSha: string;
  /** When the cache entry was created */
  fetchedAt: Date;
}

/**
 * How far back, on GitHub's clock, the baseline also reads the default
 * branch's updates. GitHub documents its contributor data as possibly "a few
 * hours old"; a day is comfortably past that.
 */
const RECENT_UPDATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Logger function type */
type LogFn = (message: string) => void;

/**
 * Cache for repository contributors.
 * Provides efficient lookup of all authors who have contributed to a repo.
 */
export class ContributorCache {
  private cache: Map<string, RepoCacheEntry> = new Map();
  private githubAuth: GitHubAuth;
  private log: LogFn;

  constructor(githubAuth: GitHubAuth, log?: LogFn) {
    this.githubAuth = githubAuth;
    this.log = log || (() => {});
  }

  /**
   * Get cache key for a repo
   */
  private getCacheKey(owner: string, repo: string): string {
    return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  }

  /**
   * Get all authors for a repository at a given commit SHA.
   *
   * This combines:
   * 1. The cached baseline: contributors, and the authors of the default
   *    branch's updates in the day before it was read
   * 2. Commit authors since the cached SHA
   *
   * @param accessToken GitHub access token
   * @param owner Repository owner
   * @param repo Repository name
   * @param jobSha The commit SHA for the job being checked
   * @returns Set of all author logins (lowercase)
   */
  async getAllAuthors(
    accessToken: string,
    owner: string,
    repo: string,
    jobSha: string
  ): Promise<Set<string>> {
    const cacheKey = this.getCacheKey(owner, repo);
    let entry = this.cache.get(cacheKey);

    if (!entry) {
      // Cache miss - fetch contributors and current default branch SHA
      this.log(`[ContributorCache] Cache miss for ${owner}/${repo}, fetching contributors...`);
      entry = await this.fetchAndCache(accessToken, owner, repo);
    }

    // Start with cached contributors
    const authors = new Set(entry.contributors);

    // If the job SHA is different from cached SHA, fetch commits since then
    if (jobSha !== entry.defaultBranchSha) {
      this.log(`[ContributorCache] Fetching commits from ${entry.defaultBranchSha.slice(0, 7)} to ${jobSha.slice(0, 7)}`);
      try {
        const newAuthors = await this.githubAuth.getCommitAuthors(
          accessToken,
          owner,
          repo,
          entry.defaultBranchSha,
          jobSha
        );

        for (const author of newAuthors) {
          authors.add(author);
        }

        if (newAuthors.length > 0) {
          this.log(`[ContributorCache] Found ${newAuthors.length} new author(s) in commits`);
        }
      } catch (error) {
        // Refresh the cache so the next attempt starts from current data, then
        // propagate. Returning the contributor list here would look like
        // success while silently omitting whoever authored the new commits,
        // and callers gate job execution on this set.
        this.log(`[ContributorCache] Failed to get commits for ${owner}/${repo}: ${(error as Error).message}`);
        await this.fetchAndCache(accessToken, owner, repo).catch(() => undefined);
        throw error;
      }
    }

    return authors;
  }

  /**
   * Fetch contributors and cache them with the current default branch SHA.
   */
  private async fetchAndCache(
    accessToken: string,
    owner: string,
    repo: string
  ): Promise<RepoCacheEntry> {
    const cacheKey = this.getCacheKey(owner, repo);

    // The head first. Later commits reach this set through the compare from
    // it, so everything up to it must be covered here. The contributor list
    // alone does not: GitHub serves it from a cache that can be a few hours
    // old, so a commit merged shortly before this read may be missing from
    // it. Every update of the default branch GitHub recorded in the last day
    // closes that gap, with each one's commits taken by ancestry (compare
    // before...after, which also covers a force push). So commits are chosen
    // by when GitHub saw them land, never by the dates a committer wrote into
    // them. An update read after the head only adds authors. Any part that
    // cannot be read in full throws, and then nothing is cached.
    const branchInfo = await this.githubAuth.getDefaultBranch(accessToken, owner, repo);
    const contributors = await this.githubAuth.getContributors(accessToken, owner, repo);
    const updates = await this.githubAuth.getRecentBranchUpdates(
      accessToken,
      owner,
      repo,
      branchInfo.name,
      RECENT_UPDATE_WINDOW_MS
    );

    const recentAuthors: string[] = [];
    const read = new Set<string>();
    for (const update of updates) {
      const range = `${update.before}...${update.after}`;
      if (isNullSha(update.after) || read.has(range)) {
        // A deletion adds no commits; a range already read adds no authors.
        continue;
      }
      read.add(range);
      // A branch created within the window has no earlier commit to compare
      // from, so its whole history is read - for a new repository, the first
      // push - and one longer than the read limit refuses the job.
      const authors = isNullSha(update.before)
        ? await this.githubAuth.getHistoryAuthors(accessToken, owner, repo, update.after)
        : await this.githubAuth.getCommitAuthors(accessToken, owner, repo, update.before, update.after);
      recentAuthors.push(...authors);
    }

    const entry: RepoCacheEntry = {
      contributors: new Set([...contributors, ...recentAuthors]),
      defaultBranchSha: branchInfo.sha,
      fetchedAt: new Date(),
    };

    this.cache.set(cacheKey, entry);
    this.log(`[ContributorCache] Cached ${contributors.length} contributors and ${updates.length} recent update(s) for ${owner}/${repo} at ${branchInfo.sha.slice(0, 7)}`);

    return entry;
  }

  /**
   * Invalidate cache for a repository.
   * Call this when a target is removed.
   */
  invalidate(owner: string, repo: string): void {
    const cacheKey = this.getCacheKey(owner, repo);
    if (this.cache.delete(cacheKey)) {
      this.log(`[ContributorCache] Invalidated cache for ${owner}/${repo}`);
    }
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
    this.log('[ContributorCache] Cleared all cache entries');
  }

  /**
   * Get cache statistics for debugging.
   */
  getStats(): { repoCount: number; entries: Array<{ repo: string; contributorCount: number; age: number }> } {
    const entries = Array.from(this.cache.entries()).map(([key, entry]) => ({
      repo: key,
      contributorCount: entry.contributors.size,
      age: Date.now() - entry.fetchedAt.getTime(),
    }));

    return {
      repoCount: this.cache.size,
      entries,
    };
  }
}
