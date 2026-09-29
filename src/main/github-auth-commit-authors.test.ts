const mockGet = jest.fn();
jest.mock('./github-client', () => ({
  GitHubClient: jest.fn().mockImplementation(() => ({ get: mockGet })),
}));

import { GitHubAuth } from './github-auth';
import { ContributorCache } from './contributor-cache';
import { areAllUsersAllowed } from './runner/user-filter';

describe('GitHubAuth.getCommitAuthors', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  const compare = (commits: Array<{ sha: string; login?: string }>) => ({
    total_commits: commits.length,
    commits: commits.map(({ sha, login }) => ({
      sha,
      author: login ? { login } : null,
      commit: { author: { name: 'Someone' } },
    })),
  });

  it('reports a commit with no linked account as an author no allowlist can match', async () => {
    // GitHub leaves `author` null when the commit's email is tied to no
    // account - anyone can write such a commit and have it merged or pushed.
    // Skipping it made the author set look trusted while code nobody vouched
    // for ran.
    mockGet.mockResolvedValue(compare([
      { sha: 'aaaaaaa1111111', login: 'Me' },
      { sha: 'bbbbbbb2222222' },
    ]));

    const authors = await new GitHubAuth().getCommitAuthors('token', 'o', 'r', 'base', 'head');

    expect(authors).toContain('me');
    expect(authors).toHaveLength(2);
    const unattributed = authors.find((a) => a !== 'me')!;
    expect(unattributed).toContain('bbbbbbb');
    // Whatever the list holds, it is not a login: GitHub logins are
    // alphanumerics and hyphens.
    expect(unattributed).not.toMatch(/^[a-z0-9-]+$/);
  });

  it('makes contributors admission refuse a job whose history has an unattributed commit', async () => {
    mockGet.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith('/contributors')) return [{ login: 'me' }];
      if (endpoint === '/repos/o/r') return { default_branch: 'main' };
      if (endpoint.includes('/branches/')) return { name: 'main', commit: { sha: 'base' } };
      if (endpoint.includes('/compare/')) return compare([{ sha: 'ccccccc3333333' }]);
      throw new Error(`unexpected ${endpoint}`);
    });
    const cache = new ContributorCache(new GitHubAuth());

    const authors = await cache.getAllAuthors('token', 'o', 'r', 'head');
    const verdict = areAllUsersAllowed(
      authors,
      { scope: 'contributors', allowedUsers: 'allowlist', allowlist: [{ login: 'me', avatar_url: '', name: null }] },
      'me'
    );

    expect(verdict.allowed).toBe(false);
  });
});
