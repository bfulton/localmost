/* eslint-disable @typescript-eslint/no-explicit-any */
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
jest.mock('./app-state', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

// Mock runner-proxy-manager
const mockRegister = jest.fn<() => Promise<void>>();
const mockUnregister = jest.fn<() => Promise<void>>();
jest.mock('./runner-proxy-manager', () => ({
  getRunnerProxyManager: jest.fn(() => ({
    register: mockRegister,
    unregister: mockUnregister,
  })),
}));

import { TargetManager, getTargetManager } from './target-manager';
import type { Target } from '../shared/types';

describe('TargetManager', () => {
  let manager: TargetManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadConfig.mockReturnValue({ targets: [] });
    mockRegister.mockResolvedValue(undefined);
    mockUnregister.mockResolvedValue(undefined);
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
      expect(mockRegister).toHaveBeenCalled();
      expect(mockSaveConfig).toHaveBeenCalled();
    });

    it('should add an org target successfully', async () => {
      mockLoadConfig.mockReturnValue({ targets: [] });

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
      expect(mockRegister).toHaveBeenCalled();
      expect(mockSaveConfig).toHaveBeenCalled();
    });

    it('should return error when proxy registration fails', async () => {
      mockLoadConfig.mockReturnValue({ targets: [] });
      mockRegister.mockRejectedValue(new Error('Registration failed'));

      const result = await manager.addTarget('repo', 'testowner', 'testrepo');

      expect(result.success).toBe(false);
      expect(result.success === false && result.error).toBe('Failed to register runner: Registration failed');
      expect(mockSaveConfig).not.toHaveBeenCalled();
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
      expect(mockUnregister).toHaveBeenCalledWith(target);
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
      mockUnregister.mockRejectedValue(new Error('Unregister failed'));

      const result = await manager.removeTarget('test-1');

      expect(result.success).toBe(true);
      expect(mockSaveConfig).toHaveBeenCalledWith({ targets: [] });
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

    it('should clamp value to maximum of 16', () => {
      mockLoadConfig.mockReturnValue({});
      manager.setMaxConcurrentJobs(100);
      expect(mockSaveConfig).toHaveBeenCalledWith({ maxConcurrentJobs: 16 });
    });
  });

  describe('getTargetManager singleton', () => {
    it('should return same instance', () => {
      const instance1 = getTargetManager();
      const instance2 = getTargetManager();
      expect(instance1).toBe(instance2);
    });
  });
});
