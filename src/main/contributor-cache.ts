/**
 * Contributor Cache
 *
 * Caches repository contributors to efficiently check if all code authors
 * are trusted. Uses SHA-based cache invalidation instead of TTL:
 * - Store contributors with the default branch SHA when fetched
 * - On subsequent checks, fetch commits since that SHA and add their authors
 * - This is deterministic and never stale
 */

import { GitHubAuth } from './github-auth';

/** Cache entry for a repository */
interface RepoCacheEntry {
  /** Set of contributor logins (lowercase) */
  contributors: Set<string>;
  /** SHA of default branch when contributors were fetched */
  defaultBranchSha: string;
  /** When the cache entry was created */
  fetchedAt: Date;
}

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
   * 1. Cached contributors (from API at time of cache)
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
        // If we can't get commits (e.g., SHA not found after force push),
        // we should re-fetch the full contributor list to be safe
        this.log(`[ContributorCache] Failed to get commits, re-fetching contributors: ${(error as Error).message}`);
        entry = await this.fetchAndCache(accessToken, owner, repo);
        return new Set(entry.contributors);
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

    // Fetch contributors and default branch info in parallel
    const [contributors, branchInfo] = await Promise.all([
      this.githubAuth.getContributors(accessToken, owner, repo),
      this.githubAuth.getDefaultBranch(accessToken, owner, repo),
    ]);

    const entry: RepoCacheEntry = {
      contributors: new Set(contributors),
      defaultBranchSha: branchInfo.sha,
      fetchedAt: new Date(),
    };

    this.cache.set(cacheKey, entry);
    this.log(`[ContributorCache] Cached ${contributors.length} contributors for ${owner}/${repo} at ${branchInfo.sha.slice(0, 7)}`);

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
