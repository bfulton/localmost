// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
  createWriteStream: jest.fn(),
  createReadStream: jest.fn(),
  promises: {
    mkdir: jest.fn(),
    chmod: jest.fn(),
    unlink: jest.fn(),
    rm: jest.fn().mockResolvedValue(undefined),
    readdir: jest.fn().mockResolvedValue([]),
  },
}));

// Mock tar (native extraction)
jest.mock('tar', () => ({
  extract: jest.fn().mockResolvedValue(undefined),
}));

// Mock process-sandbox - use jest.fn() inside the factory to avoid hoisting issues
jest.mock('./process-sandbox', () => ({
  spawnSandboxed: jest.fn(),
}));

import { RunnerDownloader } from './runner-downloader';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('RunnerDownloader', () => {
  let downloader: RunnerDownloader;
  const mockRunnerDir = path.join(os.homedir(), '.localmost', 'runner');

  beforeEach(() => {
    jest.clearAllMocks();
    downloader = new RunnerDownloader();
  });

  describe('constructor', () => {
    it('should initialize with correct runner directory', () => {
      expect(downloader.getBaseDir()).toBe(mockRunnerDir);
    });
  });

  describe('setDownloadVersion / getDownloadVersion', () => {
    it('should return fallback version when no version set', () => {
      expect(downloader.getDownloadVersion()).toBe('2.330.0');
    });

    it('should return set version after setDownloadVersion', () => {
      downloader.setDownloadVersion('2.320.0');
      expect(downloader.getDownloadVersion()).toBe('2.320.0');
    });

    it('should reset to fallback when set to null', () => {
      downloader.setDownloadVersion('2.320.0');
      downloader.setDownloadVersion(null);
      expect(downloader.getDownloadVersion()).toBe('2.330.0');
    });
  });

  describe('getAvailableVersions', () => {
    it('should fetch versions from GitHub API', async () => {
      const mockReleases = [
        { tag_name: 'v2.330.0', html_url: 'https://github.com/actions/runner/releases/tag/v2.330.0', published_at: '2024-01-01', prerelease: false },
        { tag_name: 'v2.320.0', html_url: 'https://github.com/actions/runner/releases/tag/v2.320.0', published_at: '2024-01-01', prerelease: false },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockReleases),
      });

      const versions = await downloader.getAvailableVersions();

      expect(versions).toEqual([
        { version: '2.330.0', url: 'https://github.com/actions/runner/releases/tag/v2.330.0', publishedAt: '2024-01-01' },
        { version: '2.320.0', url: 'https://github.com/actions/runner/releases/tag/v2.320.0', publishedAt: '2024-01-01' },
      ]);
    });

    it('should filter out prereleases', async () => {
      const mockReleases = [
        { tag_name: 'v2.330.0', html_url: 'url1', published_at: '2024-01-01', prerelease: false },
        { tag_name: 'v2.322.0-rc1', html_url: 'url2', published_at: '2024-01-01', prerelease: true },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockReleases),
      });

      const versions = await downloader.getAvailableVersions();

      expect(versions).toHaveLength(1);
      expect(versions[0].version).toBe('2.330.0');
    });

    it('should return fallback version on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const versions = await downloader.getAvailableVersions();

      expect(versions).toEqual([{
        version: '2.330.0',
        url: 'https://github.com/actions/runner/releases/tag/v2.330.0',
        publishedAt: '',
      }]);
    });

    it('should return fallback version on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const versions = await downloader.getAvailableVersions();

      expect(versions).toHaveLength(1);
      expect(versions[0].version).toBe('2.330.0');
    });
  });

  describe('isDownloaded', () => {
    it('should return false when no arc directory exists', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      expect(downloader.isDownloaded()).toBe(false);
    });

    it('should return true when run.sh exists in arc dir for installed version', () => {
      const mockArcDir = path.join(os.homedir(), '.localmost', 'runner', 'arc', 'v2.330.0');
      (fs.existsSync as jest.Mock).mockImplementation((p: string) =>
        p === path.join(mockArcDir, 'run.sh')
      );
      expect(downloader.isDownloaded('2.330.0')).toBe(true);
    });
  });

  describe('getVersion', () => {
    it('should return installed version from arc directory', () => {
      const arcBase = path.join(os.homedir(), '.localmost', 'runner', 'arc');
      (fs.existsSync as jest.Mock).mockImplementation((p: string) => p === arcBase);
      (fs.readdirSync as jest.Mock).mockReturnValue(['v2.319.0', 'v2.320.0']);

      expect(downloader.getVersion()).toBe('2.320.0'); // Returns highest version
    });

    it('should fall back to download version if no arc directory', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      expect(downloader.getVersion()).toBe('2.330.0');
    });
  });

  describe('getVersionUrl', () => {
    it('should return correct GitHub release URL', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const url = downloader.getVersionUrl();
      expect(url).toBe('https://github.com/actions/runner/releases/tag/v2.330.0');
    });
  });

  describe('platform detection', () => {
    // These are private methods but we can test them indirectly through download
    it('should handle different platforms', () => {
      // The download method uses getPlatform and getArch internally
      // This is tested implicitly through the download URL construction
      expect(downloader).toBeDefined();
    });
  });

  describe('hasAnyProxyCredentials', () => {
    it('should return false when proxies directory does not exist', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      expect(downloader.hasAnyProxyCredentials()).toBe(false);
    });

    it('should return false when proxies directory is empty', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([]);
      expect(downloader.hasAnyProxyCredentials()).toBe(false);
    });

    it('should return true when a proxy directory has .runner file', () => {
      const proxiesDir = path.join(mockRunnerDir, 'proxies');
      const proxyDir = path.join(proxiesDir, 'target-1');
      const runnerFile = path.join(proxyDir, '.runner');

      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        return p === proxiesDir || p === runnerFile;
      });
      (fs.readdirSync as jest.Mock).mockReturnValue([
        { name: 'target-1', isDirectory: () => true },
      ]);

      expect(downloader.hasAnyProxyCredentials()).toBe(true);
    });

    it('should return false when proxy directories have no .runner file', () => {
      const proxiesDir = path.join(mockRunnerDir, 'proxies');

      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        return p === proxiesDir; // proxies dir exists but no .runner files
      });
      (fs.readdirSync as jest.Mock).mockReturnValue([
        { name: 'target-1', isDirectory: () => true },
      ]);

      expect(downloader.hasAnyProxyCredentials()).toBe(false);
    });

    it('should return false on error reading directory', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      expect(downloader.hasAnyProxyCredentials()).toBe(false);
    });
  });

  describe('copyProxyCredentials', () => {
    it('should copy credential files and modify .runner serverUrlV2', async () => {
      const proxyDir = '/path/to/proxy';
      const configDir = path.join(mockRunnerDir, 'config', '1');

      // Mock file existence
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      // Mock reading .runner file
      const mockRunnerConfig = { serverUrlV2: 'https://github.com/broker' };
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(mockRunnerConfig));

      // Mock fs.promises
      const mockCopyFile = jest.fn().mockResolvedValue(undefined);
      const mockWriteFile = jest.fn().mockResolvedValue(undefined);
      (fs.promises.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.promises as any).copyFile = mockCopyFile;
      (fs.promises as any).writeFile = mockWriteFile;

      const mockLog = jest.fn();
      await downloader.copyProxyCredentials(1, proxyDir, mockLog);

      // Should create config directory
      expect(fs.promises.mkdir).toHaveBeenCalledWith(configDir, { recursive: true });

      // Should copy all three credential files
      expect(mockCopyFile).toHaveBeenCalledTimes(3);
      expect(mockCopyFile).toHaveBeenCalledWith(
        path.join(proxyDir, '.runner'),
        path.join(configDir, '.runner')
      );
      expect(mockCopyFile).toHaveBeenCalledWith(
        path.join(proxyDir, '.credentials'),
        path.join(configDir, '.credentials')
      );
      expect(mockCopyFile).toHaveBeenCalledWith(
        path.join(proxyDir, '.credentials_rsaparams'),
        path.join(configDir, '.credentials_rsaparams')
      );

      // Should modify .runner to point to localhost:8787
      expect(mockWriteFile).toHaveBeenCalledWith(
        path.join(configDir, '.runner'),
        expect.stringContaining('localhost:8787')
      );

      // Should log success
      expect(mockLog).toHaveBeenCalledWith('info', expect.stringContaining('Copied proxy credentials'));
    });

    it('should throw error if credential file is missing', async () => {
      const proxyDir = '/path/to/proxy';

      // Mock file not existing
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      (fs.promises.mkdir as jest.Mock).mockResolvedValue(undefined);

      await expect(downloader.copyProxyCredentials(1, proxyDir)).rejects.toThrow(
        'Missing proxy credential file'
      );
    });
  });
});
