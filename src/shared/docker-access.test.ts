import { describe, it, expect } from '@jest/globals';
import { DOCKER_ACCESS_LEVELS, isDockerAccessLevel } from './docker-access';

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
