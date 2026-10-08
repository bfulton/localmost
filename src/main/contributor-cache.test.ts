import { ContributorCache } from './contributor-cache';

interface StubAuth {
  getContributors: jest.Mock;
  getDefaultBranch: jest.Mock;
  getCommitAuthors: jest.Mock;
  getHistoryAuthors: jest.Mock;
  getRecentBranchUpdates: jest.Mock;
}

function makeAuth(overrides: Partial<StubAuth> = {}): StubAuth {
  return {
    getContributors: jest.fn().mockResolvedValue(['trusted']),
    getDefaultBranch: jest.fn().mockResolvedValue({ name: 'main', sha: 'base000' }),
    getCommitAuthors: jest.fn().mockResolvedValue([]),
    getHistoryAuthors: jest.fn().mockResolvedValue([]),
    getRecentBranchUpdates: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as StubAuth;
}

function makeCache(auth: StubAuth): ContributorCache {
  return new ContributorCache(auth as never, () => {});
}

const sha = (c: string): string => c.repeat(40);
const ZERO = sha('0');

describe('ContributorCache', () => {
  it('includes authors of commits made since the cached SHA', async () => {
    const auth = makeAuth({ getCommitAuthors: jest.fn().mockResolvedValue(['stranger']) });
    const cache = makeCache(auth);

    const authors = await cache.getAllAuthors('token', 'owner', 'repo', 'head111');

    expect(authors).toEqual(new Set(['trusted', 'stranger']));
    // The per-job compare runs from the head the baseline was read at to the
    // job's commit, as before.
    expect(auth.getCommitAuthors).toHaveBeenCalledTimes(1);
    expect(auth.getCommitAuthors).toHaveBeenCalledWith('token', 'owner', 'repo', 'base000', 'head111');
  });

  it('with no recent default-branch updates, reads just the contributor list', async () => {
    const auth = makeAuth();

    const authors = await makeCache(auth).getAllAuthors('token', 'owner', 'repo', 'base000');

    expect(authors).toEqual(new Set(['trusted']));
    expect(auth.getRecentBranchUpdates).toHaveBeenCalledWith('token', 'owner', 'repo', 'main', 24 * 60 * 60 * 1000);
    expect(auth.getCommitAuthors).not.toHaveBeenCalled();
    expect(auth.getHistoryAuthors).not.toHaveBeenCalled();
  });

  it('adds the authors of each recent default-branch update, by ancestry', async () => {
    // GitHub caches contributor data for a few hours, so the list can predate
    // commits already on the branch; the compare from the head starts after
    // them. Each update's own range names them.
    const auth = makeAuth({
      getRecentBranchUpdates: jest.fn().mockResolvedValue([
        { before: sha('b'), after: sha('c'), type: 'pr_merge' },
        { before: sha('a'), after: sha('b'), type: 'push' },
      ]),
      getCommitAuthors: jest.fn(async (_t: string, _o: string, _r: string, base: string) =>
        base === sha('a') ? ['pusher'] : ['merger']
      ),
    });

    const authors = await makeCache(auth).getAllAuthors('token', 'owner', 'repo', 'base000');

    expect(authors).toEqual(new Set(['trusted', 'pusher', 'merger']));
    expect(auth.getCommitAuthors).toHaveBeenCalledWith('token', 'owner', 'repo', sha('b'), sha('c'));
    expect(auth.getCommitAuthors).toHaveBeenCalledWith('token', 'owner', 'repo', sha('a'), sha('b'));
  });

  it('compares a force push from the commit it replaced', async () => {
    // `before` is not an ancestor of `after`; compare before...after still
    // gives the commits in `after` past their merge base.
    const auth = makeAuth({
      getRecentBranchUpdates: jest.fn().mockResolvedValue([
        { before: sha('d'), after: sha('e'), type: 'force_push' },
      ]),
      getCommitAuthors: jest.fn().mockResolvedValue(['rewriter']),
    });

    const authors = await makeCache(auth).getAllAuthors('token', 'owner', 'repo', 'base000');

    expect(authors).toEqual(new Set(['trusted', 'rewriter']));
    expect(auth.getCommitAuthors).toHaveBeenCalledWith('token', 'owner', 'repo', sha('d'), sha('e'));
  });

  it('reads the whole history of a branch created within the window, and skips a deletion', async () => {
    const auth = makeAuth({
      getRecentBranchUpdates: jest.fn().mockResolvedValue([
        { before: ZERO, after: sha('f'), type: 'branch_creation' },
        { before: sha('9'), after: ZERO, type: 'branch_deletion' },
      ]),
      getHistoryAuthors: jest.fn().mockResolvedValue(['founder']),
    });

    const authors = await makeCache(auth).getAllAuthors('token', 'owner', 'repo', 'base000');

    expect(authors).toEqual(new Set(['trusted', 'founder']));
    expect(auth.getHistoryAuthors).toHaveBeenCalledWith('token', 'owner', 'repo', sha('f'));
    expect(auth.getCommitAuthors).not.toHaveBeenCalled();
  });

  it('fails closed, and caches nothing, when the branch updates cannot be read', async () => {
    const auth = makeAuth({
      getRecentBranchUpdates: jest.fn().mockRejectedValue(new Error('502 Bad Gateway')),
    });
    const cache = makeCache(auth);

    await expect(cache.getAllAuthors('token', 'owner', 'repo', 'base000')).rejects.toThrow(/502 Bad Gateway/);
    expect(cache.getStats().repoCount).toBe(0);

    // The next job reads the baseline afresh rather than from a partial one.
    auth.getRecentBranchUpdates.mockResolvedValue([]);
    await cache.getAllAuthors('token', 'owner', 'repo', 'base000');
    expect(auth.getDefaultBranch).toHaveBeenCalledTimes(2);
  });

  it('fails closed, and caches nothing, when an update range cannot be read in full', async () => {
    const auth = makeAuth({
      getRecentBranchUpdates: jest.fn().mockResolvedValue([
        { before: sha('a'), after: sha('b'), type: 'push' },
      ]),
      getCommitAuthors: jest.fn().mockRejectedValue(
        new Error('compare returned 250 of 300 commits; author list would be incomplete')
      ),
    });
    const cache = makeCache(auth);

    await expect(cache.getAllAuthors('token', 'owner', 'repo', 'base000')).rejects.toThrow(/250 of 300/);
    expect(cache.getStats().repoCount).toBe(0);
  });

  it('reads the default branch head before the contributor list and its updates', async () => {
    // Fetched the other way round (or together), a commit that lands between
    // the reads could be missed by all: the compare starts after the head,
    // and a list or update log read first predates it.
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
      getRecentBranchUpdates: jest.fn(async () => {
        order.push(branchDone ? 'updates:after-branch' : 'updates:before-branch');
        return [];
      }),
    });

    await makeCache(auth).getAllAuthors('token', 'owner', 'repo', 'base000');

    expect(order).toEqual(['branch:start', 'branch:done', 'contributors:after-branch', 'updates:after-branch']);
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
