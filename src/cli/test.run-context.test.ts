import { describe, it, expect, jest } from '@jest/globals';
import { buildWorkflowEnv, buildProxyEnv, installInterruptHandlers } from './test';

describe('installInterruptHandlers', () => {
  it('ends the run before exiting on Ctrl-C, a kill, or the terminal closing', () => {
    // Steps run in the macOS VM, which the terminal's signals never reach; a
    // closed terminal or dropped SSH session sends this process SIGHUP, whose
    // default is to die without running any cleanup.
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
        const reap = jest.fn();
        const before = process.listenerCount(signal);
        const remove = installInterruptHandlers(reap);
        expect({ signal, added: process.listenerCount(signal) - before }).toEqual({ signal, added: 1 });
        process.emit(signal, signal);
        expect(reap).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenLastCalledWith(code);
        remove();
        expect(process.listenerCount(signal)).toBe(before);
      }
    } finally {
      exit.mockRestore();
    }
  });
});

describe('buildProxyEnv', () => {
  it('sends traffic through the proxy but leaves loopback direct', () => {
    // The proxy refuses loopback, so a test that talks to a server another
    // step started on the guest's localhost has to reach it directly.
    const env = buildProxyEnv('http://localmost:t@127.0.0.1:1234');
    expect(env.HTTPS_PROXY).toBe('http://localmost:t@127.0.0.1:1234');
    expect(env.http_proxy).toBe('http://localmost:t@127.0.0.1:1234');
    for (const name of ['NO_PROXY', 'no_proxy']) {
      expect(env[name]?.split(',')).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '::1']));
    }
  });

  it("tells git to send the proxy's credentials up front", () => {
    // Without it git waits for a 407 challenge the proxy answers by closing
    // the connection, and every fetch through the proxy aborts.
    expect(buildProxyEnv('http://localmost:t@127.0.0.1:1234').GIT_HTTP_PROXY_AUTHMETHOD).toBe('basic');
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
