import { describe, it, expect } from '@jest/globals';
import {
  DOCKER_ACCESS_LEVELS,
  isDockerAccessLevel,
  resolveDockerEndpoint,
  dockerSandboxGrants,
  DockerFsProbe,
  DockerGrants,
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

describe('dockerSandboxGrants', () => {
  const homeDir = '/Users/dev';
  const endpoint = { socketPath: '/Users/dev/.docker/run/docker.sock' };
  const empty: DockerGrants = { socketLiterals: [], readLiterals: [], readSubpaths: [], env: {} };

  it('grants nothing when the level is off', () => {
    expect(dockerSandboxGrants('off', endpoint, homeDir)).toEqual(empty);
  });

  it('grants nothing when no level is declared', () => {
    expect(dockerSandboxGrants(undefined, endpoint, homeDir)).toEqual(empty);
  });

  it('grants nothing when no daemon socket resolved', () => {
    expect(dockerSandboxGrants('credentials', null, homeDir)).toEqual(empty);
  });

  it('grants the socket and injects DOCKER_HOST at socket level', () => {
    expect(dockerSandboxGrants('socket', endpoint, homeDir)).toEqual({
      socketLiterals: ['/Users/dev/.docker/run/docker.sock'],
      readLiterals: [],
      readSubpaths: [],
      env: { DOCKER_HOST: 'unix:///Users/dev/.docker/run/docker.sock' },
    });
  });

  it('does not open config.json at socket level', () => {
    const grants = dockerSandboxGrants('socket', endpoint, homeDir);
    expect(grants.readLiterals).not.toContain('/Users/dev/.docker/config.json');
  });

  it('adds the contexts directory at contexts level', () => {
    const grants = dockerSandboxGrants('contexts', endpoint, homeDir);
    expect(grants.readSubpaths).toEqual(['/Users/dev/.docker/contexts']);
    expect(grants.readLiterals).toEqual([]);
  });

  it('adds config.json at credentials level, keeping the lower grants', () => {
    const grants = dockerSandboxGrants('credentials', endpoint, homeDir);
    expect(grants.socketLiterals).toEqual(['/Users/dev/.docker/run/docker.sock']);
    expect(grants.readSubpaths).toEqual(['/Users/dev/.docker/contexts']);
    expect(grants.readLiterals).toEqual(['/Users/dev/.docker/config.json']);
  });

  it('never grants the ~/.docker directory itself', () => {
    for (const level of ['socket', 'contexts', 'credentials'] as const) {
      const grants = dockerSandboxGrants(level, endpoint, homeDir);
      expect(grants.readSubpaths).not.toContain('/Users/dev/.docker');
    }
  });
});
