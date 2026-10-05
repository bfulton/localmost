// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
  createWriteStream: jest.fn(),
  createReadStream: jest.fn(),
  promises: {
    mkdir: jest.fn(),
    mkdtemp: jest.fn(),
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

// config.sh is spawned directly, under no sandbox: registration runs no workflow code.
jest.mock('child_process', () => ({
  ...jest.requireActual<typeof import('child_process')>('child_process'),
  spawn: jest.fn(),
}));

import { spawn } from 'child_process';
import { RunnerDownloader } from './runner-downloader';
import { FALLBACK_RUNNER_VERSION } from '../shared/constants';
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
      expect(downloader.getDownloadVersion()).toBe(FALLBACK_RUNNER_VERSION);
    });

    it('should return set version after setDownloadVersion', () => {
      downloader.setDownloadVersion('2.320.0');
      expect(downloader.getDownloadVersion()).toBe('2.320.0');
    });

    it('should reset to fallback when set to null', () => {
      downloader.setDownloadVersion('2.320.0');
      downloader.setDownloadVersion(null);
      expect(downloader.getDownloadVersion()).toBe(FALLBACK_RUNNER_VERSION);
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
        version: FALLBACK_RUNNER_VERSION,
        url: `https://github.com/actions/runner/releases/tag/v${FALLBACK_RUNNER_VERSION}`,
        publishedAt: '',
      }]);
    });

    it('should return fallback version on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const versions = await downloader.getAvailableVersions();

      expect(versions).toHaveLength(1);
      expect(versions[0].version).toBe(FALLBACK_RUNNER_VERSION);
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

      expect(downloader.getVersion()).toBe(FALLBACK_RUNNER_VERSION);
    });
  });

  describe('getVersionUrl', () => {
    it('should return correct GitHub release URL', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const url = downloader.getVersionUrl();
      expect(url).toBe(`https://github.com/actions/runner/releases/tag/v${FALLBACK_RUNNER_VERSION}`);
    });
  });

  describe('the release it downloads', () => {
    const realArch = process.arch;
    const runningOn = (arch: string) => Object.defineProperty(process, 'arch', { value: arch });

    afterEach(() => runningOn(realArch));

    it('fetches the Apple silicon (arm64) runner', async () => {
      runningOn('arm64');
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      (fs.promises.mkdtemp as jest.Mock).mockResolvedValue(path.join(mockRunnerDir, 'arc-staging-1'));
      // A release whose notes carry no checksum: the error names the asset
      // the download looked for.
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ body: '' }) });

      await expect(downloader.download(() => {})).rejects.toThrow('Checksum not found for osx-arm64 in release notes');
    });

    it.each(['x64', 'ia32'])('refuses to fetch a runner for %s, before touching the network or disk', async (arch) => {
      runningOn(arch);
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      await expect(downloader.download(() => {})).rejects.toThrow(
        `localmost runs on Apple silicon (arm64) only, not ${arch}`,
      );
      expect(mockFetch).not.toHaveBeenCalled();
      expect(fs.promises.mkdtemp).not.toHaveBeenCalled();
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

    it('should return true when a target has instance with .runner file', () => {
      // New structure: proxies/<target-id>/1/.runner
      const proxiesDir = path.join(mockRunnerDir, 'proxies');
      const targetDir = path.join(proxiesDir, 'target-1');
      const instanceDir = path.join(targetDir, '1');
      const runnerFile = path.join(instanceDir, '.runner');

      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        return p === proxiesDir || p === runnerFile;
      });
      (fs.readdirSync as jest.Mock).mockImplementation((p: string) => {
        if (p === proxiesDir) {
          return [{ name: 'target-1', isDirectory: () => true }];
        }
        if (p === targetDir) {
          return [{ name: '1', isDirectory: () => true }];
        }
        return [];
      });

      expect(downloader.hasAnyProxyCredentials()).toBe(true);
    });

    it('should return false when target has no instance directories with .runner file', () => {
      const proxiesDir = path.join(mockRunnerDir, 'proxies');
      const targetDir = path.join(proxiesDir, 'target-1');

      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        return p === proxiesDir; // proxies dir exists but no .runner files
      });
      (fs.readdirSync as jest.Mock).mockImplementation((p: string) => {
        if (p === proxiesDir) {
          return [{ name: 'target-1', isDirectory: () => true }];
        }
        if (p === targetDir) {
          return [{ name: '1', isDirectory: () => true }];
        }
        return [];
      });

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

  describe('configureInstance', () => {
    it('hands config.sh the registration token in its environment, not its arguments', async () => {
      // Any local user can read another process's arguments with ps.
      const { EventEmitter } = jest.requireActual('events') as typeof import('events');
      const sandboxDir = path.join(mockRunnerDir, 'sandbox', '1');
      jest.spyOn(downloader, 'buildSandbox').mockResolvedValue(sandboxDir);
      jest.spyOn(downloader, 'saveConfig').mockResolvedValue(undefined);
      jest.spyOn(downloader, 'configureForBrokerProxy').mockResolvedValue(undefined);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (spawn as jest.Mock).mockImplementation(() => {
        const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
        setImmediate(() => proc.emit('close', 0));
        return proc;
      });

      await downloader.configureInstance(1, '2.336.0', {
        url: 'https://github.com/owner/repo',
        token: 'REGISTRATION-TOKEN',
        name: 'localmost.x.1',
        labels: ['self-hosted'],
      });

      const [script, args, options] = (spawn as jest.Mock).mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv; shell?: boolean }];
      // config.sh itself, here on the Mac: not through sandbox-exec, nor a shell.
      expect(script).toBe(path.join(sandboxDir, 'config.sh'));
      expect(options.shell).toBe(false);
      expect(args.join(' ')).not.toContain('REGISTRATION-TOKEN');
      expect(args).not.toContain('--token');
      expect(options.env.ACTIONS_RUNNER_INPUT_TOKEN).toBe('REGISTRATION-TOKEN');
      expect(args).toEqual(expect.arrayContaining(['--url', 'https://github.com/owner/repo', '--unattended']));
    });

    it.each([
      ['succeeds', 0],
      ['fails', 1],
    ])('registers in a sandbox of its own, saves from it, and removes it when config.sh %s', async (_outcome, code) => {
      // Built for this registration alone: a worker's leftover cannot reach
      // it, and nothing of it is left for a later start of the slot.
      const { EventEmitter } = jest.requireActual('events') as typeof import('events');
      const sandboxDir = path.join(mockRunnerDir, 'sandbox', '1-0123456789ab');
      jest.spyOn(downloader, 'buildSandbox').mockResolvedValue(sandboxDir);
      const saveConfig = jest.spyOn(downloader, 'saveConfig').mockResolvedValue(undefined);
      const removeSandbox = jest.spyOn(downloader, 'removeSandbox').mockResolvedValue(undefined);
      jest.spyOn(downloader, 'configureForBrokerProxy').mockResolvedValue(undefined);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (spawn as jest.Mock).mockImplementation((_script: string, _args: string[], options: { cwd: string }) => {
        expect(options.cwd).toBe(sandboxDir);
        const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
        setImmediate(() => proc.emit('close', code));
        return proc;
      });

      const configured = downloader.configureInstance(1, '2.336.0', {
        url: 'https://github.com/owner/repo',
        token: 'REGISTRATION-TOKEN',
        name: 'localmost.x.1',
        labels: ['self-hosted'],
      });

      if (code === 0) {
        await configured;
        expect(saveConfig).toHaveBeenCalledWith(1, sandboxDir);
      } else {
        await expect(configured).rejects.toThrow(/Configuration failed/);
        expect(saveConfig).not.toHaveBeenCalled();
      }
      expect(removeSandbox).toHaveBeenCalledWith(sandboxDir);
    });

    it('refuses to run a config.sh outside the sandbox directory', async () => {
      jest.spyOn(downloader, 'buildSandbox').mockResolvedValue('/tmp/elsewhere/1-0123456789ab');
      jest.spyOn(downloader, 'removeSandbox').mockResolvedValue(undefined);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (spawn as jest.Mock).mockClear();

      await expect(
        downloader.configureInstance(1, '2.336.0', { url: 'https://github.com/owner/repo', token: 't', name: 'n', labels: [] })
      ).rejects.toThrow(/not a sandbox in/);
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe('copyProxyCredentials', () => {
    it('should copy the .runner from the instance subdirectory and modify its serverUrlV2', async () => {
      // proxyBaseDir is the target directory, credentials are in proxyBaseDir/<instance>/
      const proxyBaseDir = '/path/to/proxy';
      const proxyInstanceDir = path.join(proxyBaseDir, '1');
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
      await downloader.copyProxyCredentials(1, proxyBaseDir, mockLog);

      // Should create config directory
      expect(fs.promises.mkdir).toHaveBeenCalledWith(configDir, { recursive: true });

      // Only the .runner: the registration's key stays with the broker
      expect(mockCopyFile).toHaveBeenCalledTimes(1);
      expect(mockCopyFile).toHaveBeenCalledWith(
        path.join(proxyInstanceDir, '.runner'),
        path.join(configDir, '.runner')
      );
      expect(fs.promises.rm).toHaveBeenCalledWith(path.join(configDir, '.credentials_rsaparams'), { force: true });

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
