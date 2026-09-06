import { describe, it, expect } from '@jest/globals';
import { resolveDockerEndpoint, DockerFsProbe } from './docker-access';

/** A fake machine: paths that exist, and where symlinks point. */
const probe = (paths: Record<string, string>): DockerFsProbe => ({
  exists: p => p in paths,
  realpath: p => {
    if (!(p in paths)) throw new Error(`ENOENT: ${p}`);
    return paths[p];
  },
});

describe('resolveDockerEndpoint', () => {
  const homeDir = '/Users/dev';

  it('follows /var/run/docker.sock to the Docker Desktop socket it links to', () => {
    const fs = probe({
      '/var/run/docker.sock': '/Users/dev/.docker/run/docker.sock',
      '/Users/dev/.docker/run/docker.sock': '/Users/dev/.docker/run/docker.sock',
    });

    expect(resolveDockerEndpoint({ env: {}, homeDir, fs })).toEqual({
      socketPath: '/Users/dev/.docker/run/docker.sock',
    });
  });

  it('prefers an operator-set DOCKER_HOST', () => {
    const fs = probe({
      '/var/run/docker.sock': '/var/run/docker.sock',
      '/Users/dev/.colima/default/docker.sock': '/Users/dev/.colima/default/docker.sock',
    });
    const env = { DOCKER_HOST: 'unix:///Users/dev/.colima/default/docker.sock' };

    expect(resolveDockerEndpoint({ env, homeDir, fs })).toEqual({
      socketPath: '/Users/dev/.colima/default/docker.sock',
    });
  });

  it('ignores a DOCKER_HOST that is not a unix socket', () => {
    const fs = probe({ '/var/run/docker.sock': '/var/run/docker.sock' });
    const env = { DOCKER_HOST: 'tcp://127.0.0.1:2375' };

    expect(resolveDockerEndpoint({ env, homeDir, fs })).toEqual({
      socketPath: '/var/run/docker.sock',
    });
  });

  it('falls back to the per-user path when /var/run/docker.sock is absent', () => {
    const fs = probe({
      '/Users/dev/.docker/run/docker.sock': '/Users/dev/.docker/run/docker.sock',
    });

    expect(resolveDockerEndpoint({ env: {}, homeDir, fs })).toEqual({
      socketPath: '/Users/dev/.docker/run/docker.sock',
    });
  });

  it('returns null when a path exists but cannot be resolved', () => {
    // Covers the socket being removed between the two calls. Note a dangling
    // /var/run/docker.sock - what a stopped Docker Desktop leaves behind - does
    // not reach here: existsSync follows symlinks, so it reports false and the
    // candidate is skipped. Verified against the real machine.
    const fs: DockerFsProbe = {
      exists: p => p === '/var/run/docker.sock',
      realpath: () => {
        throw new Error('ENOENT');
      },
    };

    expect(resolveDockerEndpoint({ env: {}, homeDir, fs })).toBeNull();
  });

  it('returns null when the daemon is stopped, leaving a dangling symlink', () => {
    // existsSync follows the link, so a dangling one simply is not there.
    const fs = probe({});

    expect(resolveDockerEndpoint({ env: {}, homeDir, fs })).toBeNull();
  });

  it('returns null when nothing is present', () => {
    expect(resolveDockerEndpoint({ env: {}, homeDir, fs: probe({}) })).toBeNull();
  });
});
