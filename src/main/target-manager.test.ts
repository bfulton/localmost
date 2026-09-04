 
import { jest } from '@jest/globals';

// Mock os
jest.mock('os', () => ({
  hostname: jest.fn(() => 'test-host.local'),
}));

// Mock crypto
jest.mock('crypto', () => ({
  randomUUID: jest.fn(() => '12345678-1234-1234-1234-123456789012'),
}));

// Mock config
const mockLoadConfig = jest.fn();
const mockSaveConfig = jest.fn();
jest.mock('./config', () => ({
  loadConfig: mockLoadConfig,
  saveConfig: mockSaveConfig,
}));

// Mock app-state
const mockBrokerAddTarget = jest.fn();
const mockBrokerRemoveTarget = jest.fn();
const mockGetBrokerProxyService = jest.fn<() => unknown>();
const mockHeartbeatAddTarget = jest.fn<(t: unknown) => Promise<void>>();
const mockHeartbeatRemoveTarget = jest.fn<(t: unknown) => Promise<void>>();
const mockGetHeartbeatManager = jest.fn<() => unknown>();
jest.mock('./app-state', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  getBrokerProxyService: () => mockGetBrokerProxyService(),
  getHeartbeatManager: () => mockGetHeartbeatManager(),
}));

// Mock store (targets are persisted from the store on quit, so it must stay in sync)
const mockSetTargets = jest.fn<(targets: unknown[]) => void>();
jest.mock('./store/init', () => ({
  store: {
    getState: () => ({ setTargets: mockSetTargets }),
  },
}));

// Mock runner-proxy-manager
const mockRegisterAll = jest.fn<() => Promise<Array<{ instanceNum: number }>>>();
const mockUnregisterAll = jest.fn<() => Promise<void>>();
const mockLoadAllCredentials = jest.fn<() => unknown[]>();
jest.mock('./runner-proxy-manager', () => ({
  getRunnerProxyManager: jest.fn(() => ({
    registerAll: mockRegisterAll,
    unregisterAll: mockUnregisterAll,
    loadAllCredentials: mockLoadAllCredentials,
  })),
}));

import { TargetManager, getTargetManager } from './target-manager';
import type { Target } from '../shared/types';

describe('TargetManager', () => {
  let manager: TargetManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadConfig.mockReturnValue({ targets: [], maxConcurrentJobs: 4 });
    mockRegisterAll.mockResolvedValue([{ instanceNum: 1 }, { instanceNum: 2 }, { instanceNum: 3 }, { instanceNum: 4 }]);
    mockUnregisterAll.mockResolvedValue(undefined);
    mockLoadAllCredentials.mockReturnValue([{ runner: { agentName: 'localmost.test-host.testowner-testrepo.1' } }]);
    mockGetBrokerProxyService.mockReturnValue({
      addTarget: mockBrokerAddTarget,
      removeTarget: mockBrokerRemoveTarget,
    });
    mockHeartbeatAddTarget.mockResolvedValue(undefined);
    mockHeartbeatRemoveTarget.mockResolvedValue(undefined);
    mockGetHeartbeatManager.mockReturnValue({
      addTarget: mockHeartbeatAddTarget,
      removeTarget: mockHeartbeatRemoveTarget,
    });
    manager = new TargetManager();
  });

  describe('getTargets', () => {
    it('should return empty array when no targets configured', () => {
      mockLoadConfig.mockReturnValue({});
      expect(manager.getTargets()).toEqual([]);
    });

    it('should return configured targets', () => {
      const targets: Target[] = [
        {
          id: 'test-1',
          type: 'repo',
          owner: 'testowner',
          repo: 'testrepo',
          displayName: 'testowner/testrepo',
          url: 'https://github.com/testowner/testrepo',
          proxyRunnerName: 'localmost.test-host.testowner-testrepo',
          enabled: true,
          addedAt: '2024-01-01T00:00:00.000Z',
        },
      ];
      mockLoadConfig.mockReturnValue({ targets });
      expect(manager.getTargets()).toEqual(targets);
    });
  });

  describe('getTarget', () => {
    it('should return undefined for non-existent target', () => {
      mockLoadConfig.mockReturnValue({ targets: [] });
      expect(manager.getTarget('non-existent')).toBeUndefined();
    });

    it('should return target by ID', () => {
      const target: Target = {
        id: 'test-1',
        type: 'repo',
        owner: 'testowner',
        repo: 'testrepo',
        displayName: 'testowner/testrepo',
        url: 'https://github.com/testowner/testrepo',
        proxyRunnerName: 'localmost.test-host.testowner-testrepo',
        enabled: true,
        addedAt: '2024-01-01T00:00:00.000Z',
      };
      mockLoadConfig.mockReturnValue({ targets: [target] });
      expect(manager.getTarget('test-1')).toEqual(target);
    });
  });

  describe('addTarget', () => {
    it('should require repo name for repo type targets', async () => {
      const result = await manager.addTarget('repo', 'testowner');
      expect(result.success).toBe(false);
      expect(result.success === false && result.error).toBe('Repository name is required for repo targets');
    });

    it('should reject duplicate repo targets', async () => {
      const existingTarget: Target = {
        id: 'existing',
        type: 'repo',
        owner: 'testowner',
        repo: 'testrepo',
        displayName: 'testowner/testrepo',
        url: 'https://github.com/testowner/testrepo',
        proxyRunnerName: 'localmost.test-host.testowner-testrepo',
        enabled: true,
        addedAt: '2024-01-01T00:00:00.000Z',
      };
      mockLoadConfig.mockReturnValue({ targets: [existingTarget] });

      const result = await manager.addTarget('repo', 'testowner', 'testrepo');
      expect(result.success).toBe(false);
      expect(result.success === false && result.error).toBe('This target already exists');
    });

    it('should reject duplicate org targets', async () => {
      const existingTarget: Target = {
        id: 'existing',
        type: 'org',
        owner: 'testorg',
        displayName: 'testorg',
        url: 'https://github.com/testorg',
        proxyRunnerName: 'localmost.test-host.testorg',
        enabled: true,
        addedAt: '2024-01-01T00:00:00.000Z',
      };
      mockLoadConfig.mockReturnValue({ targets: [existingTarget] });

      const result = await manager.addTarget('org', 'testorg');
      expect(result.success).toBe(false);
      expect(result.success === false && result.error).toBe('This target already exists');
    });

    it('should add a repo target successfully', async () => {
      mockLoadConfig.mockReturnValue({ targets: [] });

      const result = await manager.addTarget('repo', 'testowner', 'testrepo');

      expect(result.success).toBe(true);
      expect(result.success && result.data).toMatchObject({
        id: '12345678',
        type: 'repo',
        owner: 'testowner',
        repo: 'testrepo',
        displayName: 'testowner/testrepo',
        url: 'https://github.com/testowner/testrepo',
        proxyRunnerName: 'localmost.test-host.testowner-testrepo',
        enabled: true,
      });
      expect(mockRegisterAll).toHaveBeenCalled();
      expect(mockSaveConfig).toHaveBeenCalled();
    });

    it('should add an org target successfully', async () => {
      mockLoadConfig.mockReturnValue({ targets: [], maxConcurrentJobs: 4 });

      const result = await manager.addTarget('org', 'testorg');

      expect(result.success).toBe(true);
      expect(result.success && result.data).toMatchObject({
        id: '12345678',
        type: 'org',
        owner: 'testorg',
        displayName: 'testorg',
        url: 'https://github.com/testorg',
        proxyRunnerName: 'localmost.test-host.testorg',
        enabled: true,
      });
      expect(mockRegisterAll).toHaveBeenCalled();
      expect(mockSaveConfig).toHaveBeenCalled();
    });

    it('should return error when proxy registration fails', async () => {
      mockLoadConfig.mockReturnValue({ targets: [], maxConcurrentJobs: 4 });
      mockRegisterAll.mockRejectedValue(new Error('Registration failed'));

      const result = await manager.addTarget('repo', 'testowner', 'testrepo');

      expect(result.success).toBe(false);
      expect(result.success === false && result.error).toBe('Failed to register runner: Registration failed');
      expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('syncs the saved targets to the store', async () => {
      await manager.addTarget('repo', 'testowner', 'testrepo');

      expect(mockSetTargets).toHaveBeenCalledTimes(1);
      const synced = mockSetTargets.mock.calls[0][0] as Array<{ displayName: string }>;
      expect(synced.map(t => t.displayName)).toEqual(['testowner/testrepo']);
    });

    it('does not sync the store when registration fails', async () => {
      mockRegisterAll.mockRejectedValue(new Error('bad credentials'));

      await manager.addTarget('repo', 'testowner', 'testrepo');

      expect(mockSetTargets).not.toHaveBeenCalled();
    });
  });

  describe('removeTarget', () => {
    it('should return error for non-existent target', async () => {
      mockLoadConfig.mockReturnValue({ targets: [] });

      const result = await manager.removeTarget('non-existent');

      expect(result.success).toBe(false);
      expect(result.success === false && result.error).toBe('Target not found');
    });

    it('should remove target successfully', async () => {
      const target: Target = {
        id: 'test-1',
        type: 'repo',
        owner: 'testowner',
        repo: 'testrepo',
        displayName: 'testowner/testrepo',
        url: 'https://github.com/testowner/testrepo',
        proxyRunnerName: 'localmost.test-host.testowner-testrepo',
        enabled: true,
        addedAt: '2024-01-01T00:00:00.000Z',
      };
      mockLoadConfig.mockReturnValue({ targets: [target] });

      const result = await manager.removeTarget('test-1');

      expect(result.success).toBe(true);
      expect(mockUnregisterAll).toHaveBeenCalledWith(target);
      expect(mockSaveConfig).toHaveBeenCalledWith({ targets: [] });
    });

    it('should continue with removal even if unregister fails', async () => {
      const target: Target = {
        id: 'test-1',
        type: 'repo',
        owner: 'testowner',
        repo: 'testrepo',
        displayName: 'testowner/testrepo',
        url: 'https://github.com/testowner/testrepo',
        proxyRunnerName: 'localmost.test-host.testowner-testrepo',
        enabled: true,
        addedAt: '2024-01-01T00:00:00.000Z',
      };
      mockLoadConfig.mockReturnValue({ targets: [target] });
      mockUnregisterAll.mockRejectedValue(new Error('Unregister failed'));

      const result = await manager.removeTarget('test-1');

      expect(result.success).toBe(true);
      expect(mockSaveConfig).toHaveBeenCalledWith({ targets: [] });
    });

    it('syncs the remaining targets to the store', async () => {
      const target: Target = {
        id: 'test-1',
        type: 'repo',
        owner: 'testowner',
        repo: 'testrepo',
        displayName: 'testowner/testrepo',
        url: 'https://github.com/testowner/testrepo',
        proxyRunnerName: 'localmost.test-host.testowner-testrepo',
        enabled: true,
        addedAt: '2024-01-01T00:00:00.000Z',
      };
      mockLoadConfig.mockReturnValue({ targets: [target], maxConcurrentJobs: 4 });

      await manager.removeTarget('test-1');

      expect(mockSetTargets).toHaveBeenCalledWith([]);
    });
  });

  describe('updateTarget', () => {
    it('should return error for non-existent target', async () => {
      mockLoadConfig.mockReturnValue({ targets: [] });

      const result = await manager.updateTarget('non-existent', { enabled: false });

      expect(result.success).toBe(false);
      expect(result.success === false && result.error).toBe('Target not found');
    });

    it('should update target enabled state', async () => {
      const target: Target = {
        id: 'test-1',
        type: 'repo',
        owner: 'testowner',
        repo: 'testrepo',
        displayName: 'testowner/testrepo',
        url: 'https://github.com/testowner/testrepo',
        proxyRunnerName: 'localmost.test-host.testowner-testrepo',
        enabled: true,
        addedAt: '2024-01-01T00:00:00.000Z',
      };
      mockLoadConfig.mockReturnValue({ targets: [target] });

      const result = await manager.updateTarget('test-1', { enabled: false });

      expect(result.success).toBe(true);
      expect(result.success && result.data?.enabled).toBe(false);
      expect(mockSaveConfig).toHaveBeenCalledWith({
        targets: [{ ...target, enabled: false }],
      });
    });
  });

  describe('getMaxConcurrentJobs', () => {
    it('should return default value when not configured', () => {
      mockLoadConfig.mockReturnValue({});
      expect(manager.getMaxConcurrentJobs()).toBe(4);
    });

    it('should return configured value', () => {
      mockLoadConfig.mockReturnValue({ maxConcurrentJobs: 8 });
      expect(manager.getMaxConcurrentJobs()).toBe(8);
    });
  });

  describe('setMaxConcurrentJobs', () => {
    it('should save valid job count', () => {
      mockLoadConfig.mockReturnValue({});
      manager.setMaxConcurrentJobs(8);
      expect(mockSaveConfig).toHaveBeenCalledWith({ maxConcurrentJobs: 8 });
    });

    it('should clamp value to minimum of 1', () => {
      mockLoadConfig.mockReturnValue({});
      manager.setMaxConcurrentJobs(0);
      expect(mockSaveConfig).toHaveBeenCalledWith({ maxConcurrentJobs: 1 });
    });

    it('should clamp value to maximum of 8', () => {
      mockLoadConfig.mockReturnValue({});
      manager.setMaxConcurrentJobs(100);
      expect(mockSaveConfig).toHaveBeenCalledWith({ maxConcurrentJobs: 8 });
    });
  });

  describe('getTargetManager singleton', () => {
    it('should return same instance', () => {
      const instance1 = getTargetManager();
      const instance2 = getTargetManager();
      expect(instance1).toBe(instance2);
    });
  });

  describe('findTargetByRef', () => {
    const repoTarget: Target = {
      id: '3116ec9a',
      type: 'repo',
      owner: 'testowner',
      repo: 'testrepo',
      displayName: 'testowner/testrepo',
      url: 'https://github.com/testowner/testrepo',
      proxyRunnerName: 'localmost.test-host.testowner-testrepo',
      enabled: true,
      addedAt: '2024-01-01T00:00:00.000Z',
    };
    const orgTarget: Target = {
      id: '26c43c63',
      type: 'org',
      owner: 'testorg',
      displayName: 'testorg',
      url: 'https://github.com/testorg',
      proxyRunnerName: 'localmost.test-host.testorg',
      enabled: true,
      addedAt: '2024-01-01T00:00:00.000Z',
    };

    beforeEach(() => {
      mockLoadConfig.mockReturnValue({ targets: [repoTarget, orgTarget], maxConcurrentJobs: 4 });
    });

    it('resolves owner/repo', () => {
      expect(manager.findTargetByRef('testowner/testrepo')).toEqual(repoTarget);
    });

    it('resolves a bare owner to an org target', () => {
      expect(manager.findTargetByRef('testorg')).toEqual(orgTarget);
    });

    it('resolves a target id', () => {
      expect(manager.findTargetByRef('3116ec9a')).toEqual(repoTarget);
    });

    it('ignores case', () => {
      expect(manager.findTargetByRef('TestOwner/TestRepo')).toEqual(repoTarget);
    });

    it('returns undefined when nothing matches', () => {
      expect(manager.findTargetByRef('nobody/nothing')).toBeUndefined();
    });
  });

  describe('addTargetAndAttach', () => {
    it('attaches the new target to a running broker proxy', async () => {
      const result = await manager.addTargetAndAttach('repo', 'testowner', 'testrepo');

      expect(result.success).toBe(true);
      expect(mockBrokerAddTarget).toHaveBeenCalledTimes(1);
      const [attached, credentials] = mockBrokerAddTarget.mock.calls[0] as [Target, unknown[]];
      expect(attached.displayName).toBe('testowner/testrepo');
      expect(credentials).toHaveLength(1);
    });

    it('still succeeds when no broker proxy is running', async () => {
      mockGetBrokerProxyService.mockReturnValue(null);

      const result = await manager.addTargetAndAttach('repo', 'testowner', 'testrepo');

      expect(result.success).toBe(true);
      expect(mockBrokerAddTarget).not.toHaveBeenCalled();
    });

    it('does not attach when registration fails', async () => {
      mockRegisterAll.mockRejectedValue(new Error('bad credentials'));

      const result = await manager.addTargetAndAttach('repo', 'testowner', 'testrepo');

      expect(result.success).toBe(false);
      expect(mockBrokerAddTarget).not.toHaveBeenCalled();
    });

    it('does not attach when no credentials were stored', async () => {
      mockLoadAllCredentials.mockReturnValue([]);

      const result = await manager.addTargetAndAttach('repo', 'testowner', 'testrepo');

      expect(result.success).toBe(true);
      expect(mockBrokerAddTarget).not.toHaveBeenCalled();
    });

    it('starts heartbeating the new target', async () => {
      await manager.addTargetAndAttach('repo', 'testowner', 'testrepo');

      expect(mockHeartbeatAddTarget).toHaveBeenCalledWith({
        level: 'repo',
        owner: 'testowner',
        repo: 'testrepo',
      });
    });

    it('heartbeats a new org target at org level', async () => {
      await manager.addTargetAndAttach('org', 'testorg');

      expect(mockHeartbeatAddTarget).toHaveBeenCalledWith({ level: 'org', org: 'testorg' });
    });

    it('does not heartbeat when registration fails', async () => {
      mockRegisterAll.mockRejectedValue(new Error('bad credentials'));

      await manager.addTargetAndAttach('repo', 'testowner', 'testrepo');

      expect(mockHeartbeatAddTarget).not.toHaveBeenCalled();
    });

    it('still succeeds when no heartbeat manager exists', async () => {
      mockGetHeartbeatManager.mockReturnValue(null);

      const result = await manager.addTargetAndAttach('repo', 'testowner', 'testrepo');

      expect(result.success).toBe(true);
    });
  });

  describe('removeTargetAndDetach', () => {
    const target: Target = {
      id: 'test-1',
      type: 'repo',
      owner: 'testowner',
      repo: 'testrepo',
      displayName: 'testowner/testrepo',
      url: 'https://github.com/testowner/testrepo',
      proxyRunnerName: 'localmost.test-host.testowner-testrepo',
      enabled: true,
      addedAt: '2024-01-01T00:00:00.000Z',
    };

    it('detaches from the broker proxy before removing', async () => {
      mockLoadConfig.mockReturnValue({ targets: [target], maxConcurrentJobs: 4 });

      const result = await manager.removeTargetAndDetach('test-1');

      expect(result.success).toBe(true);
      expect(mockBrokerRemoveTarget).toHaveBeenCalledWith('test-1');
      expect(mockUnregisterAll).toHaveBeenCalled();
    });

    it('returns an error for an unknown target', async () => {
      mockLoadConfig.mockReturnValue({ targets: [], maxConcurrentJobs: 4 });

      const result = await manager.removeTargetAndDetach('nope');

      expect(result.success).toBe(false);
      expect(mockBrokerRemoveTarget).not.toHaveBeenCalled();
    });

    it('stops heartbeating the removed target', async () => {
      mockLoadConfig.mockReturnValue({ targets: [target], maxConcurrentJobs: 4 });

      await manager.removeTargetAndDetach('test-1');

      expect(mockHeartbeatRemoveTarget).toHaveBeenCalledWith({
        level: 'repo',
        owner: 'testowner',
        repo: 'testrepo',
      });
    });

    it('does not touch the heartbeat for an unknown target', async () => {
      mockLoadConfig.mockReturnValue({ targets: [], maxConcurrentJobs: 4 });

      await manager.removeTargetAndDetach('nope');

      expect(mockHeartbeatRemoveTarget).not.toHaveBeenCalled();
    });
  });

});
