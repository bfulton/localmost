import { ContributorCache } from './contributor-cache';

interface StubAuth {
  getContributors: jest.Mock;
  getDefaultBranch: jest.Mock;
  getCommitAuthors: jest.Mock;
  getRecentCommitAuthors: jest.Mock;
}

function makeAuth(overrides: Partial<StubAuth> = {}): StubAuth {
  return {
    getContributors: jest.fn().mockResolvedValue(['trusted']),
    getDefaultBranch: jest.fn().mockResolvedValue({ name: 'main', sha: 'base000' }),
    getCommitAuthors: jest.fn().mockResolvedValue([]),
    getRecentCommitAuthors: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as StubAuth;
}

function makeCache(auth: StubAuth): ContributorCache {
  return new ContributorCache(auth as never, () => {});
}

describe('ContributorCache', () => {
  it('includes authors of commits made since the cached SHA', async () => {
    const auth = makeAuth({ getCommitAuthors: jest.fn().mockResolvedValue(['stranger']) });
    const cache = makeCache(auth);

    const authors = await cache.getAllAuthors('token', 'owner', 'repo', 'head111');

    expect(authors).toEqual(new Set(['trusted', 'stranger']));
  });

  it('adds the authors of recent default-branch commits the contributor list may not show yet', async () => {
    // GitHub caches contributor data for a few hours, so the list can predate
    // commits already on the branch. The compare starts at the head, so a
    // commit in that gap would be in neither without the recent-commit walk.
    const auth = makeAuth({
      getRecentCommitAuthors: jest.fn().mockResolvedValue(['recent-stranger']),
    });
    // The clock held still for the call, so the margin is measured exactly,
    // however loaded the machine.
    const now = 1_790_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    let authors: Set<string>;
    try {
      authors = await makeCache(auth).getAllAuthors('token', 'owner', 'repo', 'base000');
    } finally {
      clock.mockRestore();
    }

    expect(authors).toEqual(new Set(['trusted', 'recent-stranger']));
    // Walked from the head that was read, back well past the cache's lag.
    const [, owner, repo, sha, since] = auth.getRecentCommitAuthors.mock.calls[0] as [string, string, string, string, Date];
    expect([owner, repo, sha]).toEqual(['owner', 'repo', 'base000']);
    expect(now - since.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('fails closed when the recent commits cannot be listed', async () => {
    const auth = makeAuth({
      getRecentCommitAuthors: jest.fn().mockRejectedValue(new Error('502 Bad Gateway')),
    });

    await expect(
      makeCache(auth).getAllAuthors('token', 'owner', 'repo', 'base000')
    ).rejects.toThrow(/502 Bad Gateway/);
  });

  it('reads the default branch head before the contributor list', async () => {
    // Fetched the other way round (or together), a commit that lands between
    // the two reads could be missed by both: the compare starts after the
    // head, and a list read first predates it. (The list is also cached by
    // GitHub for hours; the recent-commit walk above covers that lag.)
    const order: string[] = [];
    let branchDone = false;
    const auth = makeAuth({
      getDefaultBranch: jest.fn(async () => {
        order.push('branch:start');
        await new Promise((r) => setTimeout(r, 10));
        branchDone = true;
        order.push('branch:done');
        return { name: 'main', sha: 'base000' };
      }),
      getContributors: jest.fn(async () => {
        order.push(branchDone ? 'contributors:after-branch' : 'contributors:before-branch');
        return ['trusted'];
      }),
    });

    await makeCache(auth).getAllAuthors('token', 'owner', 'repo', 'base000');

    expect(order).toEqual(['branch:start', 'branch:done', 'contributors:after-branch']);
  });

  it('propagates a compare failure instead of returning a partial author set', async () => {
    // Contributor filtering is only as good as the author set it checks. If the
    // commit range cannot be resolved, returning the cached contributors looks
    // like success while silently omitting whoever authored the new commits -
    // the caller must be able to fail closed.
    const auth = makeAuth({
      getCommitAuthors: jest.fn().mockRejectedValue(new Error('404 Not Found')),
    });
    const cache = makeCache(auth);

    await expect(
      cache.getAllAuthors('token', 'owner', 'repo', 'head111')
    ).rejects.toThrow(/404 Not Found/);
  });
});
