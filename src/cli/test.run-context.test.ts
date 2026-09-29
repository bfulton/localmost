import { describe, it, expect } from '@jest/globals';
import { buildWorkflowEnv } from './test';

describe('buildWorkflowEnv', () => {
  it('never lets the workflow\'s own env replace a GITHUB_* default', () => {
    // GitHub does not let a workflow overwrite its default variables, and the
    // workflow is the checkout's to write: GITHUB_REPOSITORY and GITHUB_REF
    // spread after the defaults used to pick another repository's cache.
    const env = buildWorkflowEnv(
      { GITHUB_REPOSITORY: 'victim/repo', GITHUB_REF: 'refs/heads/main', NODE_ENV: 'test' },
      { GITHUB_REPOSITORY: 'me/repo', GITHUB_REF: 'refs/heads/pr' },
      { HTTP_PROXY: 'http://proxy' }
    );
    expect(env).toEqual({
      GITHUB_REPOSITORY: 'me/repo',
      GITHUB_REF: 'refs/heads/pr',
      NODE_ENV: 'test',
      HTTP_PROXY: 'http://proxy',
    });
  });
});
