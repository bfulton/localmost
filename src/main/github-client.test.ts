/**
 * GitHubClient's cursor paging: what it reads from a page's headers, and
 * where it sends the token for the next page.
 */

import { GitHubClient, nextLinkParams } from './github-client';

describe('nextLinkParams', () => {
  it('returns the query parameters of the next link, whichever order the links come in', () => {
    const link =
      '<https://api.github.com/repositories/1/activity?per_page=100&before=X>; rel="prev", ' +
      '<https://api.github.com/repositories/1/activity?per_page=100&after=Y%2BZ>; rel="next"';
    expect(nextLinkParams(link)).toEqual({ per_page: '100', after: 'Y+Z' });
  });

  it('returns null on the last page', () => {
    expect(nextLinkParams(null)).toBeNull();
    expect(nextLinkParams('<https://api.github.com/x?before=X>; rel="prev"')).toBeNull();
  });
});

describe('GitHubClient.getPage', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('requests the endpoint with the parameters, and returns the next cursor and GitHub\'s Date', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: {
          date: 'Tue, 06 Oct 2026 12:00:00 GMT',
          // A next link to another host: only its parameters are used, so
          // the token never goes there.
          link: '<https://elsewhere.example/steal?after=C>; rel="next"',
        },
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const page = await new GitHubClient('tok').getPage<Array<{ id: number }>>('/repos/o/r/activity', {
      ref: 'refs/heads/main',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/o/r/activity?ref=refs%2Fheads%2Fmain',
      expect.objectContaining({ method: 'GET' })
    );
    expect(page).toEqual({
      data: [{ id: 1 }],
      next: { after: 'C' },
      date: new Date('2026-10-06T12:00:00Z'),
    });
  });

  it('reports no Date when GitHub sends none, and throws on an error status', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"message":"Not Found"}', { status: 404 })) as unknown as typeof fetch;
    const client = new GitHubClient('tok');

    expect((await client.getPage('/x', {})).date).toBeNull();
    await expect(client.getPage('/x', {})).rejects.toThrow(/Not Found/);
  });
});
