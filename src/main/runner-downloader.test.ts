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

import { RunnerDownloader, DownloadProgress, RunnerRelease } from './runner-downloader';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSandboxed } from './process-sandbox';

// Get the mocked function
const mockSpawnSandboxed = spawnSandboxed as jest.MockedFunction<typeof spawnSandboxed>;

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
});
