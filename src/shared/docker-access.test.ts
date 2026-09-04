import { describe, it, expect } from '@jest/globals';
import {
  DOCKER_ACCESS_LEVELS,
  isDockerAccessLevel,
  resolveDockerEndpoint,
  DockerFsProbe,
} from './docker-access';

/** A fake machine: paths that exist, and where symlinks point. */
const probe = (paths: Record<string, string>): DockerFsProbe => ({
  exists: p => p in paths,
  realpath: p => {
    if (!(p in paths)) throw new Error(`ENOENT: ${p}`);
    return paths[p];
  },
});

describe('docker access levels', () => {
  it('lists the four levels in increasing order of access', () => {
    expect(DOCKER_ACCESS_LEVELS).toEqual(['off', 'socket', 'contexts', 'credentials']);
  });

  it('accepts every declared level', () => {
    for (const level of DOCKER_ACCESS_LEVELS) {
      expect(isDockerAccessLevel(level)).toBe(true);
    }
  });

  it('rejects a boolean, which is ambiguous about which level was meant', () => {
    expect(isDockerAccessLevel(true)).toBe(false);
    expect(isDockerAccessLevel(false)).toBe(false);
  });

  it('rejects an unknown string', () => {
    expect(isDockerAccessLevel('daemon')).toBe(false);
  });
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

  it('returns null for a dangling symlink, which is what a stopped daemon leaves', () => {
    // /var/run/docker.sock survives Docker Desktop quitting; its target does not.
    const fs: DockerFsProbe = {
      exists: p => p === '/var/run/docker.sock',
      realpath: () => {
        throw new Error('ENOENT');
      },
    };

    expect(resolveDockerEndpoint({ env: {}, homeDir, fs })).toBeNull();
  });

  it('returns null when nothing is present', () => {
    expect(resolveDockerEndpoint({ env: {}, homeDir, fs: probe({}) })).toBeNull();
  });
});
