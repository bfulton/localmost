/**
 * How GitHubAuth builds REST paths from the names it is handed.
 *
 * Owner and repo reach these methods from the CLI socket, IPC and job
 * payloads. The client is replaced with one that records each endpoint, so
 * the tests assert exactly what path would be requested with the user's
 * token.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const endpoints: string[] = [];
jest.mock('./github-client', () => ({
  GitHubClient: jest.fn().mockImplementation(() => {
    const record = (endpoint: string): Promise<unknown> => {
      endpoints.push(endpoint);
      return Promise.resolve({
        token: 't',
        runners: [],
        commits: [],
        total_commits: 0,
        default_branch: 'release/1.x',
        commit: { sha: 'abc' },
      });
    };
    return { get: record, post: record, patch: record, delete: record };
  }),
}));

import { GitHubAuth } from './github-auth';

describe('GitHubAuth API paths', () => {
  const auth = new GitHubAuth();

  beforeEach(() => {
    endpoints.length = 0;
  });

  it('encodes each owner and repo as a single path segment', async () => {
    await auth.getRunnerRegistrationToken('tok', 'a?b', 'c#d');
    await auth.listRunners('tok', 'o', 'r%2F..%2Fx');
    expect(endpoints).toEqual([
      '/repos/a%3Fb/c%23d/actions/runners/registration-token',
      '/repos/o/r%252F..%252Fx/actions/runners',
    ]);
  });

  it('cannot be steered to another endpoint by a slash in a name', async () => {
    await auth.getOrgRunnerRegistrationToken('tok', 'x/../../user/repos');
    await auth.cancelWorkflowRun('tok', 'o', 'r/../../../orgs/victim', 1);
    expect(endpoints).toEqual([
      '/orgs/x%2F..%2F..%2Fuser%2Frepos/actions/runners/registration-token',
      '/repos/o/r%2F..%2F..%2F..%2Forgs%2Fvictim/actions/runs/1/cancel',
    ]);
  });

  it('refuses a dot segment, which the URL parser would collapse before the request is sent', async () => {
    await expect(auth.getRunnerRegistrationToken('tok', '..', 'x')).rejects.toThrow(/path segment/);
    await expect(auth.getRunnerRegistrationToken('tok', 'o', '.')).rejects.toThrow(/path segment/);
    await expect(auth.deleteOrgRunner('tok', '', 1)).rejects.toThrow(/path segment/);
    expect(endpoints).toEqual([]);
  });

  it('keeps the slashes a file path or branch name legitimately has, and encodes each part', async () => {
    await auth.getFileContent('tok', 'o', 'r', 'dir/.localmostrc?raw', 'main');
    const branch = await auth.getDefaultBranch('tok', 'o', 'r');
    expect(branch.name).toBe('release/1.x');
    expect(endpoints).toEqual([
      '/repos/o/r/contents/dir/.localmostrc%3Fraw',
      '/repos/o/r',
      '/repos/o/r/branches/release/1.x',
    ]);
  });

  it('encodes both sides of a compare', async () => {
    await auth.getCommitAuthors('tok', 'o', 'r', 'aaa', 'b?c');
    expect(endpoints).toEqual(['/repos/o/r/compare/aaa...b%3Fc']);
  });
});
