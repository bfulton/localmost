const mockGet = jest.fn();
const mockGetPage = jest.fn();
jest.mock('./github-client', () => ({
  GitHubClient: jest.fn().mockImplementation(() => ({ get: mockGet, getPage: mockGetPage })),
}));

import { GitHubAuth, unattributedAuthor } from './github-auth';
import { ContributorCache } from './contributor-cache';
import { areAllUsersAllowed } from './runner/user-filter';

/** No default-branch updates in the window: the activity API's empty page. */
function noActivity(): void {
  mockGetPage.mockReset();
  mockGetPage.mockResolvedValue({ data: [], next: null, date: new Date() });
}

const sha = (c: string): string => c.repeat(40);
const ZERO = sha('0');
const HOUR = 60 * 60 * 1000;

describe('GitHubAuth.getCommitAuthors', () => {
  beforeEach(() => {
    mockGet.mockReset();
    noActivity();
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
      if (endpoint === '/repos/o/r/commits') return [];
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

describe('GitHubAuth.getContributors', () => {
  beforeEach(() => {
    mockGet.mockReset();
    noActivity();
  });

  /** One page of /contributors, as GitHub returns it with anon=1. */
  const anonymousPage = [
    { login: 'Me', type: 'User', contributions: 40 },
    { type: 'Anonymous', email: 'x@y.example', name: 'X', contributions: 3 },
    { type: 'Anonymous', name: 'No Email', contributions: 1 },
  ];

  it('asks for anonymous contributors too, and lists each as an author no allowlist can match', async () => {
    // With anon=0 GitHub leaves out every author whose email is linked to no
    // account - and, past the first 500 authors, every author at all - so the
    // baseline read as trusted while code nobody vouched for was on the
    // default branch.
    mockGet.mockResolvedValue(anonymousPage);

    const contributors = await new GitHubAuth().getContributors('token', 'o', 'r');

    expect(mockGet).toHaveBeenCalledWith(
      '/repos/o/r/contributors',
      { params: expect.objectContaining({ anon: '1' }) }
    );
    expect(contributors).toHaveLength(3);
    expect(contributors).toContain('me');
    const unattributed = contributors.filter((c) => c !== 'me');
    expect(unattributed[0]).toContain('x@y.example');
    expect(unattributed[1]).toContain('No Email');
    for (const entry of unattributed) {
      // Not a login (GitHub logins are alphanumerics and hyphens), and it says
      // why it is refused, since it is what the refusal reason lists.
      expect(entry).not.toMatch(/^[a-z0-9-]+$/);
      expect(entry).toMatch(/no linked GitHub account/);
      expect(entry).toMatch(/no allowlist/);
    }
  });

  it('makes contributors admission refuse a repository with an anonymous contributor', async () => {
    mockGet.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith('/contributors')) return anonymousPage.slice(0, 2);
      if (endpoint === '/repos/o/r') return { default_branch: 'main' };
      if (endpoint.includes('/branches/')) return { name: 'main', commit: { sha: 'head' } };
      if (endpoint === '/repos/o/r/commits') return [];
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
    expect(verdict.disallowedUsers).toEqual([expect.stringContaining('x@y.example')]);
  });
});

describe('GitHubAuth.getCommitAuthors paging', () => {
  beforeEach(() => {
    mockGet.mockReset();
    noActivity();
  });

  /** A compare page of `count` commits starting at `from`, of a range of `total`. */
  const comparePage = (total: number, from: number, count: number, login = 'Me') => ({
    total_commits: total,
    commits: Array.from({ length: count }, (_, i) => ({
      sha: `c${String(from + i).padStart(39, '0')}`,
      author: { login: from + i === total - 1 ? 'Last' : login },
    })),
  });

  it('reads past the 250 commits compare returns unpaged, page by page', async () => {
    mockGet
      .mockResolvedValueOnce(comparePage(260, 0, 100))
      .mockResolvedValueOnce(comparePage(260, 100, 100))
      .mockResolvedValueOnce(comparePage(260, 200, 60));

    const authors = await new GitHubAuth().getCommitAuthors('token', 'o', 'r', 'base', 'head');

    expect(authors.sort()).toEqual(['last', 'me']);
    expect(mockGet).toHaveBeenCalledTimes(3);
    for (const page of ['1', '2', '3']) {
      expect(mockGet).toHaveBeenCalledWith('/repos/o/r/compare/base...head', {
        params: { per_page: '100', page },
      });
    }
  });

  it('refuses a compare whose pages add up to less than its total', async () => {
    // The commit that would have named 'last' is never returned.
    mockGet
      .mockResolvedValueOnce(comparePage(300, 0, 100))
      .mockResolvedValueOnce(comparePage(300, 100, 100))
      .mockResolvedValueOnce(comparePage(300, 200, 50));

    await expect(
      new GitHubAuth().getCommitAuthors('token', 'o', 'r', 'base', 'head')
    ).rejects.toThrow(/returned 250 of 300 commits/);
  });

  it('refuses a compare longer than it reads, without reading it', async () => {
    mockGet.mockResolvedValueOnce(comparePage(1001, 0, 100));

    await expect(
      new GitHubAuth().getCommitAuthors('token', 'o', 'r', 'base', 'head')
    ).rejects.toThrow(/1001 commits, more than the 1000/);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});

describe('GitHubAuth.getHistoryAuthors', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  const commit = (s: string, login?: string) => ({ sha: s, author: login ? { login } : null });

  it('walks every page of the history from the commit and names each author', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => commit(`f${String(i).padStart(13, '0')}`, 'Me'));
    mockGet
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce([commit('ddddddd4444444', 'Other'), commit('eeeeeee5555555')]);

    const authors = await new GitHubAuth().getHistoryAuthors('token', 'o', 'r', 'head');

    expect(mockGet).toHaveBeenNthCalledWith(1, '/repos/o/r/commits', {
      params: { sha: 'head', per_page: '100', page: '1' },
    });
    expect(mockGet).toHaveBeenNthCalledWith(2, '/repos/o/r/commits', {
      params: { sha: 'head', per_page: '100', page: '2' },
    });
    expect(authors).toHaveLength(3);
    expect(authors).toEqual(expect.arrayContaining(['me', 'other', expect.stringContaining('eeeeeee')]));
  });

  it('refuses a history longer than it reads', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => commit(`f${String(i).padStart(13, '0')}`, 'Me'));
    mockGet.mockResolvedValue(fullPage);

    await expect(
      new GitHubAuth().getHistoryAuthors('token', 'o', 'r', 'head')
    ).rejects.toThrow(/longer than the 1000 commits/);
    expect(mockGet).toHaveBeenCalledTimes(10);
  });

  it('throws rather than returning a partial list', async () => {
    mockGet.mockRejectedValue(new Error('502 Bad Gateway'));

    await expect(
      new GitHubAuth().getHistoryAuthors('token', 'o', 'r', 'head')
    ).rejects.toThrow(/502 Bad Gateway/);
  });
});

describe('GitHubAuth.getRecentBranchUpdates', () => {
  beforeEach(() => {
    mockGetPage.mockReset();
  });

  const now = Date.parse('2026-10-06T12:00:00Z');
  /** An activity entry, in the shape GitHub's "List repository activities" documents. */
  const activity = (before: string, after: string, hoursAgo: number, type = 'push', ref = 'refs/heads/main') => ({
    id: Math.floor(hoursAgo * 1000),
    node_id: 'RA_x',
    before,
    after,
    ref,
    timestamp: new Date(now - hoursAgo * HOUR).toISOString(),
    activity_type: type,
    actor: { login: 'someone' },
  });

  it('asks for the branch newest first, follows the cursor, and stops at the window GitHub\'s clock gives', async () => {
    mockGetPage
      .mockResolvedValueOnce({
        data: [activity(sha('b'), sha('c'), 1, 'pr_merge'), activity(sha('a'), sha('b'), 5, 'force_push')],
        next: { ref: 'refs/heads/main', direction: 'desc', per_page: '100', after: 'CURSOR' },
        date: new Date(now),
      })
      .mockResolvedValueOnce({
        data: [activity(ZERO, sha('a'), 23), activity(sha('8'), sha('9'), 25)],
        next: { after: 'CURSOR2' },
        date: new Date(now + 1000),
      });

    const updates = await new GitHubAuth().getRecentBranchUpdates('token', 'o', 'r', 'main', 24 * HOUR);

    expect(mockGetPage).toHaveBeenNthCalledWith(1, '/repos/o/r/activity', {
      ref: 'refs/heads/main',
      direction: 'desc',
      per_page: '100',
    });
    expect(mockGetPage).toHaveBeenNthCalledWith(2, '/repos/o/r/activity', expect.objectContaining({ after: 'CURSOR' }));
    // The entry 25 hours old is past the window, and so is everything after it.
    expect(mockGetPage).toHaveBeenCalledTimes(2);
    expect(updates).toEqual([
      { before: sha('b'), after: sha('c'), type: 'pr_merge' },
      { before: sha('a'), after: sha('b'), type: 'force_push' },
      { before: ZERO, after: sha('a'), type: 'push' },
    ]);
  });

  it('throws when the activity API fails', async () => {
    mockGetPage.mockRejectedValue(new Error('403 Resource not accessible by integration'));

    await expect(
      new GitHubAuth().getRecentBranchUpdates('token', 'o', 'r', 'main', 24 * HOUR)
    ).rejects.toThrow(/403 Resource not accessible/);
  });

  it('throws when the window runs past the pages it reads', async () => {
    mockGetPage.mockResolvedValue({
      data: [activity(sha('a'), sha('b'), 0.5)],
      next: { after: 'MORE' },
      date: new Date(now),
    });

    await expect(
      new GitHubAuth().getRecentBranchUpdates('token', 'o', 'r', 'main', 24 * HOUR)
    ).rejects.toThrow(/more than 1000 updates of main/);
    expect(mockGetPage).toHaveBeenCalledTimes(10);
  });

  it('throws on an entry for another ref, out of order, or without a commit range', async () => {
    const page = (data: unknown[]) => ({ data, next: null, date: new Date(now) });
    const auth = new GitHubAuth();

    mockGetPage.mockResolvedValueOnce(page([activity(sha('a'), sha('b'), 1, 'push', 'refs/heads/feature')]));
    await expect(auth.getRecentBranchUpdates('token', 'o', 'r', 'main', 24 * HOUR)).rejects.toThrow(/refs\/heads\/feature/);

    mockGetPage.mockResolvedValueOnce(page([activity(sha('a'), sha('b'), 3), activity(sha('b'), sha('c'), 1)]));
    await expect(auth.getRecentBranchUpdates('token', 'o', 'r', 'main', 24 * HOUR)).rejects.toThrow(/out of order/);

    mockGetPage.mockResolvedValueOnce(page([activity('', sha('b'), 1)]));
    await expect(auth.getRecentBranchUpdates('token', 'o', 'r', 'main', 24 * HOUR)).rejects.toThrow(/no commit range/);
  });

  it('throws without GitHub\'s Date to measure the window from', async () => {
    mockGetPage.mockResolvedValueOnce({ data: [], next: null, date: null });

    await expect(
      new GitHubAuth().getRecentBranchUpdates('token', 'o', 'r', 'main', 24 * HOUR)
    ).rejects.toThrow(/no Date header/);
  });
});

describe('contributors admission and a commit backdated past the window', () => {
  // The gap the date-based walk left: a commit whose author date is set days
  // back, merged within the hours GitHub's contributor list lags. The list
  // does not name its author yet, the walk "commits since a day ago" skips it
  // (GitHub's `since` goes by commit date, which the committer writes), and
  // the job runs at the head, so the per-job compare is empty.
  //
  // This fake GitHub serves both the endpoints the date-based walk read and
  // the ones the activity-based baseline reads, each as GitHub documents it,
  // so the same scenario ran against the code before this change admitted
  // the job.
  const now = Date.now();
  const A = sha('a');
  const B = sha('b');
  const history: Record<string, Array<{ sha: string; login: string; date: number }>> = {
    [B]: [
      { sha: B, login: 'Mallory', date: now - 3 * 24 * HOUR },
      { sha: A, login: 'Me', date: now - 90 * 24 * HOUR },
    ],
  };

  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockImplementation(async (endpoint: string, options?: { params?: Record<string, string> }) => {
      const params = options?.params ?? {};
      // Served from GitHub's cache, which still predates the merge of B.
      if (endpoint === '/repos/o/r/contributors') return params.page === '1' ? [{ login: 'Me' }] : [];
      if (endpoint === '/repos/o/r') return { default_branch: 'main' };
      if (endpoint === '/repos/o/r/branches/main') return { name: 'main', commit: { sha: B } };
      if (endpoint === '/repos/o/r/commits') {
        const since = params.since ? Date.parse(params.since) : -Infinity;
        return (history[params.sha] ?? [])
          .filter((c) => c.date >= since)
          .map((c) => ({ sha: c.sha, author: { login: c.login }, commit: { author: { date: new Date(c.date).toISOString() } } }));
      }
      if (endpoint === `/repos/o/r/compare/${A}...${B}`) {
        return { total_commits: 1, commits: [{ sha: B, author: { login: 'Mallory' } }] };
      }
      throw new Error(`unexpected ${endpoint}`);
    });
    mockGetPage.mockReset();
    mockGetPage.mockImplementation(async (endpoint: string) => {
      if (endpoint !== '/repos/o/r/activity') throw new Error(`unexpected ${endpoint}`);
      // GitHub recorded the merge an hour ago, whatever date B carries.
      return {
        data: [{
          id: 1,
          node_id: 'RA_1',
          before: A,
          after: B,
          ref: 'refs/heads/main',
          timestamp: new Date(now - HOUR).toISOString(),
          activity_type: 'pr_merge',
          actor: { login: 'me' },
        }],
        next: null,
        date: new Date(now),
      };
    });
  });

  it('is a commit a walk of the commits dated within the day does not return', async () => {
    // What the baseline used to read, as this fake GitHub answers it.
    const since = new Date(now - 24 * HOUR).toISOString();
    expect(await mockGet('/repos/o/r/commits', { params: { sha: B, since } })).toEqual([]);
  });

  it('refuses the job: the merge GitHub recorded names the commit\'s author', async () => {
    const cache = new ContributorCache(new GitHubAuth());

    const authors = await cache.getAllAuthors('token', 'o', 'r', B);
    const verdict = areAllUsersAllowed(
      authors,
      { scope: 'contributors', allowedUsers: 'allowlist', allowlist: [{ login: 'me', avatar_url: '', name: null }] },
      'me'
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.disallowedUsers).toEqual(['mallory']);
  });
});

describe('unattributedAuthor', () => {
  it('keeps commit metadata from reordering or hiding text in the refusal reason', () => {
    // An email or name is whatever the committer wrote. A right-to-left
    // override or a zero-width character in it would make the reason shown
    // in the UI and job history read as something else.
    const shown = unattributedAuthor('evil‮gro.elpmaxe@​me');
    expect(shown).not.toMatch(/[‮​]/);
    expect(shown).toContain('evil?gro.elpmaxe@?me');
  });

  it('shortens by characters, never splitting one in half', () => {
    // 99 ASCII characters and then an emoji, a surrogate pair in UTF-16: a cut
    // at 100 code units would leave half of it.
    const shown = unattributedAuthor('a'.repeat(99) + '\u{1F600}' + 'tail');
    expect(shown).toContain('a'.repeat(99) + '\u{1F600}:');
    expect(shown).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
