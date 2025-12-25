 
import { jest } from '@jest/globals';

// Mock fs
const mockExistsSync = jest.fn<(path: string) => boolean>();
const mockReadFileSync = jest.fn<(path: string, encoding: string) => string>();
const mockMkdir = jest.fn<() => Promise<void>>();
const mockRm = jest.fn<() => Promise<void>>();
const mockCopyFile = jest.fn<() => Promise<void>>();
const mockReadFile = jest.fn<() => Promise<string>>();
const mockWriteFile = jest.fn<() => Promise<void>>();
const mockUnlink = jest.fn<() => Promise<void>>();
const mockReaddir = jest.fn<() => Promise<{ name: string; isDirectory: () => boolean }[]>>();
const mockStat = jest.fn<() => Promise<{ mode: number }>>();
const mockChmod = jest.fn<() => Promise<void>>();

jest.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  promises: {
    mkdir: mockMkdir,
    rm: mockRm,
    copyFile: mockCopyFile,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    unlink: mockUnlink,
    readdir: mockReaddir,
    stat: mockStat,
    chmod: mockChmod,
  },
}));

// Mock child_process
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  spawn: mockSpawn,
}));

// Mock paths
jest.mock('./paths', () => ({
  getRunnerDir: jest.fn(() => '/mock/runner/dir'),
}));

// Mock app-state
const mockGetLogger = jest.fn(() => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
const mockGetGitHubAuth = jest.fn();
const mockGetRunnerDownloader = jest.fn();
jest.mock('./app-state', () => ({
  getLogger: mockGetLogger,
  getGitHubAuth: mockGetGitHubAuth,
  getRunnerDownloader: mockGetRunnerDownloader,
}));

// Mock auth-tokens
const mockGetValidAccessToken = jest.fn<() => Promise<string | null>>();
jest.mock('./auth-tokens', () => ({
  getValidAccessToken: mockGetValidAccessToken,
}));

import { RunnerProxyManager, getRunnerProxyManager } from './runner-proxy-manager';
import type { Target } from '../shared/types';

const createMockTarget = (overrides?: Partial<Target>): Target => ({
  id: 'test-target-id',
  type: 'repo',
  owner: 'testowner',
  repo: 'testrepo',
  displayName: 'testowner/testrepo',
  url: 'https://github.com/testowner/testrepo',
  proxyRunnerName: 'localmost.test-host.testowner-testrepo',
  enabled: true,
  addedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

describe('RunnerProxyManager', () => {
  let manager: RunnerProxyManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new RunnerProxyManager();
  });

  describe('hasCredentials', () => {
    it('should return false when credential files do not exist', () => {
      mockExistsSync.mockReturnValue(false);
      expect(manager.hasCredentials('test-id')).toBe(false);
    });

    it('should return true when all credential files exist', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        const pathStr = p as string;
        return pathStr.includes('.runner') ||
               pathStr.includes('.credentials') ||
               pathStr.includes('.credentials_rsaparams');
      });
      expect(manager.hasCredentials('test-id')).toBe(true);
    });

    it('should return false when some credential files are missing', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        const pathStr = p as string;
        // Only .runner and .credentials exist, but NOT .credentials_rsaparams
        if (pathStr.endsWith('.credentials_rsaparams')) return false;
        if (pathStr.endsWith('.runner')) return true;
        if (pathStr.endsWith('.credentials')) return true;
        return false;
      });
      expect(manager.hasCredentials('test-id')).toBe(false);
    });
  });

  describe('loadCredentials', () => {
    const mockRunnerConfig = {
      agentId: 1,
      agentName: 'test-runner',
      poolId: 1,
      poolName: 'Default',
      serverUrl: 'https://pipelines.actions.githubusercontent.com',
      gitHubUrl: 'https://github.com',
      workFolder: '_work',
      useV2Flow: true,
      serverUrlV2: 'https://broker.actions.githubusercontent.com/',
    };

    const mockCredentials = {
      scheme: 'OAuth',
      data: {
        clientId: 'test-client-id',
        authorizationUrl: 'https://vstoken.actions.githubusercontent.com',
        requireFipsCryptography: 'false',
      },
    };

    const mockRsaParams = {
      d: 'mock-d',
      dp: 'mock-dp',
      dq: 'mock-dq',
      exponent: 'mock-exponent',
      inverseQ: 'mock-inverseQ',
      modulus: 'mock-modulus',
      p: 'mock-p',
      q: 'mock-q',
    };

    it('should return null when credential files do not exist', () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('File not found');
      });

      expect(manager.loadCredentials('test-id')).toBeNull();
    });

    it('should load and parse credential files successfully', () => {
      mockReadFileSync.mockImplementation((p: unknown) => {
        const pathStr = p as string;
        if (pathStr.includes('.runner')) {
          return JSON.stringify(mockRunnerConfig);
        } else if (pathStr.includes('.credentials_rsaparams')) {
          return JSON.stringify(mockRsaParams);
        } else if (pathStr.includes('.credentials')) {
          return JSON.stringify(mockCredentials);
        }
        throw new Error('Unknown file');
      });

      const result = manager.loadCredentials('test-id');

      expect(result).not.toBeNull();
      expect(result?.runner).toEqual(mockRunnerConfig);
      expect(result?.credentials).toEqual(mockCredentials);
      expect(result?.rsaParams).toEqual(mockRsaParams);
    });

    it('should handle BOM in JSON files', () => {
      mockReadFileSync.mockImplementation((p: unknown) => {
        const pathStr = p as string;
        const bom = '\uFEFF';
        if (pathStr.includes('.runner')) {
          return bom + JSON.stringify(mockRunnerConfig);
        } else if (pathStr.includes('.credentials_rsaparams')) {
          return bom + JSON.stringify(mockRsaParams);
        } else if (pathStr.includes('.credentials')) {
          return bom + JSON.stringify(mockCredentials);
        }
        throw new Error('Unknown file');
      });

      const result = manager.loadCredentials('test-id');

      expect(result).not.toBeNull();
      expect(result?.runner).toEqual(mockRunnerConfig);
    });
  });

  describe('register', () => {
    it('should throw when GitHub auth not initialized', async () => {
      mockGetGitHubAuth.mockReturnValue(null);
      mockGetRunnerDownloader.mockReturnValue({});

      const target = createMockTarget();
      await expect(manager.register(target)).rejects.toThrow('Runner not initialized');
    });

    it('should throw when runner downloader not initialized', async () => {
      mockGetGitHubAuth.mockReturnValue({});
      mockGetRunnerDownloader.mockReturnValue(null);

      const target = createMockTarget();
      await expect(manager.register(target)).rejects.toThrow('Runner not initialized');
    });

    it('should throw when not authenticated', async () => {
      mockGetGitHubAuth.mockReturnValue({});
      mockGetRunnerDownloader.mockReturnValue({});
      mockGetValidAccessToken.mockResolvedValue(null);

      const target = createMockTarget();
      await expect(manager.register(target)).rejects.toThrow('Not authenticated');
    });

    it('should throw when no runner version installed', async () => {
      mockGetGitHubAuth.mockReturnValue({
        getRunnerRegistrationToken: jest.fn<() => Promise<string>>().mockResolvedValue('test-token'),
      });
      mockGetRunnerDownloader.mockReturnValue({
        getInstalledVersion: jest.fn(() => null),
      });
      mockGetValidAccessToken.mockResolvedValue('test-token');

      const target = createMockTarget();
      await expect(manager.register(target)).rejects.toThrow('No runner version installed');
    });
  });

  describe('unregister', () => {
    it('should remove local credentials even if GitHub deletion fails', async () => {
      mockGetGitHubAuth.mockReturnValue({
        listRunners: jest.fn<() => Promise<any[]>>().mockRejectedValue(new Error('API error')),
      });
      mockGetValidAccessToken.mockResolvedValue('test-token');
      mockRm.mockResolvedValue(undefined);

      const target = createMockTarget();
      await manager.unregister(target);

      expect(mockRm).toHaveBeenCalledWith(
        expect.stringContaining('test-target-id'),
        { recursive: true, force: true }
      );
    });

    it('should delete GitHub runner when found for repo target', async () => {
      const mockDeleteRunner = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      mockGetGitHubAuth.mockReturnValue({
        listRunners: jest.fn<() => Promise<any[]>>().mockResolvedValue([
          { id: 123, name: 'localmost.test-host.testowner-testrepo', status: 'online' },
        ]),
        deleteRunner: mockDeleteRunner,
      });
      mockGetValidAccessToken.mockResolvedValue('test-token');
      mockRm.mockResolvedValue(undefined);

      const target = createMockTarget();
      await manager.unregister(target);

      expect(mockDeleteRunner).toHaveBeenCalledWith('test-token', 'testowner', 'testrepo', 123);
    });

    it('should delete GitHub runner when found for org target', async () => {
      const mockDeleteOrgRunner = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      mockGetGitHubAuth.mockReturnValue({
        listOrgRunners: jest.fn<() => Promise<any[]>>().mockResolvedValue([
          { id: 456, name: 'localmost.test-host.testorg', status: 'online' },
        ]),
        deleteOrgRunner: mockDeleteOrgRunner,
      });
      mockGetValidAccessToken.mockResolvedValue('test-token');
      mockRm.mockResolvedValue(undefined);

      const target = createMockTarget({
        type: 'org',
        owner: 'testorg',
        repo: undefined,
        displayName: 'testorg',
        url: 'https://github.com/testorg',
        proxyRunnerName: 'localmost.test-host.testorg',
      });
      await manager.unregister(target);

      expect(mockDeleteOrgRunner).toHaveBeenCalledWith('test-token', 'testorg', 456);
    });
  });

  describe('clearCredentials', () => {
    it('should remove credential files', async () => {
      mockUnlink.mockResolvedValue(undefined);

      await manager.clearCredentials('test-id');

      expect(mockUnlink).toHaveBeenCalledTimes(3);
      expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('.runner'));
      expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('.credentials'));
      expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('.credentials_rsaparams'));
    });

    it('should ignore errors when deleting files', async () => {
      mockUnlink.mockRejectedValue(new Error('File not found'));

      // Should not throw
      await manager.clearCredentials('test-id');
    });
  });

  describe('getRunnerProxyManager singleton', () => {
    it('should return same instance', () => {
      const instance1 = getRunnerProxyManager();
      const instance2 = getRunnerProxyManager();
      expect(instance1).toBe(instance2);
    });
  });
});
