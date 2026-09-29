import { describe, it, expect } from '@jest/globals';
import { buildWorkflowEnv, buildProxyEnv } from './test';

describe('buildProxyEnv', () => {
  it('sends traffic through the proxy but leaves loopback direct', () => {
    // The proxy refuses loopback, so a test that talks to a server it started
    // on localhost has to reach it directly, as its sandbox allows.
    const env = buildProxyEnv('http://localmost:t@127.0.0.1:1234');
    expect(env.HTTPS_PROXY).toBe('http://localmost:t@127.0.0.1:1234');
    expect(env.http_proxy).toBe('http://localmost:t@127.0.0.1:1234');
    for (const name of ['NO_PROXY', 'no_proxy']) {
      expect(env[name]?.split(',')).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '::1']));
    }
  });
});

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
