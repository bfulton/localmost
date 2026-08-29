import { ContributorCache } from './contributor-cache';

interface StubAuth {
  getContributors: jest.Mock;
  getDefaultBranch: jest.Mock;
  getCommitAuthors: jest.Mock;
}

function makeAuth(overrides: Partial<StubAuth> = {}): StubAuth {
  return {
    getContributors: jest.fn().mockResolvedValue(['trusted']),
    getDefaultBranch: jest.fn().mockResolvedValue({ name: 'main', sha: 'base000' }),
    getCommitAuthors: jest.fn().mockResolvedValue([]),
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
