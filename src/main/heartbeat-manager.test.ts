import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { HeartbeatManager, HeartbeatTarget, toHeartbeatTarget } from './heartbeat-manager';
import { HEARTBEAT_VARIABLE_NAME } from '../shared/constants';
import type { Target } from '../shared/types';

const STALE_TIMESTAMP = '1970-01-01T00:00:00Z';

describe('HeartbeatManager', () => {
  let manager: HeartbeatManager;
  let setRepoVariable: jest.Mock<(o: string, r: string, n: string, v: string) => Promise<void>>;
  let setOrgVariable: jest.Mock<(o: string, n: string, v: string) => Promise<void>>;

  const supdb: HeartbeatTarget = { level: 'repo', owner: 'bfulton', repo: 'supdb' };
  const voightKampff: HeartbeatTarget = { level: 'repo', owner: 'bfulton', repo: 'voight-kampff' };

  /** Repos that received a heartbeat write, in order. */
  const writtenRepos = (): string[] =>
    setRepoVariable.mock.calls.map(([owner, repo]) => `${owner}/${repo}`);

  beforeEach(() => {
    setRepoVariable = jest.fn<(o: string, r: string, n: string, v: string) => Promise<void>>();
    setOrgVariable = jest.fn<(o: string, n: string, v: string) => Promise<void>>();
    setRepoVariable.mockResolvedValue(undefined);
    setOrgVariable.mockResolvedValue(undefined);

    manager = new HeartbeatManager();
    manager.setApiCallbacks({ setRepoVariable, setOrgVariable });
    manager.setTargets([supdb]);
  });

  afterEach(() => {
    manager.stop();
  });

  describe('addTarget', () => {
    it('heartbeats a target added while running, without waiting for the next tick', async () => {
      await manager.start();
      setRepoVariable.mockClear();

      await manager.addTarget(voightKampff);

      expect(writtenRepos()).toEqual(['bfulton/voight-kampff']);
      expect(setRepoVariable.mock.calls[0][2]).toBe(HEARTBEAT_VARIABLE_NAME);
      expect(setRepoVariable.mock.calls[0][3]).not.toBe(STALE_TIMESTAMP);
    });

    it('includes the added target in later heartbeat rounds', async () => {
      await manager.start();
      await manager.addTarget(voightKampff);
      setRepoVariable.mockClear();

      await manager.clear();

      expect(writtenRepos().sort()).toEqual(['bfulton/supdb', 'bfulton/voight-kampff']);
    });

    it('does not call GitHub when the heartbeat is not running', async () => {
      await manager.addTarget(voightKampff);

      expect(setRepoVariable).not.toHaveBeenCalled();
    });

    it('does not add the same target twice', async () => {
      await manager.start();
      await manager.addTarget(voightKampff);
      await manager.addTarget(voightKampff);
      setRepoVariable.mockClear();

      await manager.clear();

      expect(writtenRepos().filter(r => r === 'bfulton/voight-kampff')).toHaveLength(1);
    });

    it('survives a GitHub failure', async () => {
      await manager.start();
      setRepoVariable.mockRejectedValue(new Error('403'));

      await expect(manager.addTarget(voightKampff)).resolves.toBeUndefined();
    });

    it('adds org targets', async () => {
      await manager.start();
      setOrgVariable.mockClear();

      await manager.addTarget({ level: 'org', org: 'testorg' });

      expect(setOrgVariable).toHaveBeenCalledWith('testorg', HEARTBEAT_VARIABLE_NAME, expect.any(String));
    });
  });

  describe('removeTarget', () => {
    it('stops heartbeating a removed target', async () => {
      manager.setTargets([supdb, voightKampff]);
      await manager.start();
      await manager.removeTarget(voightKampff);
      setRepoVariable.mockClear();

      await manager.clear();

      expect(writtenRepos()).toEqual(['bfulton/supdb']);
    });

    it('marks the removed target stale so workflows stop dispatching to it', async () => {
      manager.setTargets([supdb, voightKampff]);
      await manager.start();
      setRepoVariable.mockClear();

      await manager.removeTarget(voightKampff);

      expect(setRepoVariable).toHaveBeenCalledWith(
        'bfulton',
        'voight-kampff',
        HEARTBEAT_VARIABLE_NAME,
        STALE_TIMESTAMP
      );
    });

    it('does not call GitHub when the heartbeat is not running', async () => {
      manager.setTargets([supdb, voightKampff]);

      await manager.removeTarget(voightKampff);

      expect(setRepoVariable).not.toHaveBeenCalled();
    });

    it('ignores a target that was never added', async () => {
      await manager.start();
      setRepoVariable.mockClear();

      await manager.removeTarget(voightKampff);

      expect(setRepoVariable).not.toHaveBeenCalled();
    });

    it('survives a GitHub failure', async () => {
      manager.setTargets([supdb, voightKampff]);
      await manager.start();
      setRepoVariable.mockRejectedValue(new Error('403'));

      await expect(manager.removeTarget(voightKampff)).resolves.toBeUndefined();
    });
  });

  describe('toHeartbeatTarget', () => {
    const base = {
      id: 'abc',
      displayName: 'bfulton/supdb',
      url: 'https://github.com/bfulton/supdb',
      proxyRunnerName: 'localmost.host.bfulton-supdb',
      enabled: true,
      addedAt: '2026-01-01T00:00:00.000Z',
    };

    it('maps a repo target', () => {
      const target: Target = { ...base, type: 'repo', owner: 'bfulton', repo: 'supdb' };
      expect(toHeartbeatTarget(target)).toEqual({ level: 'repo', owner: 'bfulton', repo: 'supdb' });
    });

    it('maps an org target', () => {
      const target: Target = { ...base, type: 'org', owner: 'testorg', displayName: 'testorg' };
      expect(toHeartbeatTarget(target)).toEqual({ level: 'org', org: 'testorg' });
    });
  });
});
