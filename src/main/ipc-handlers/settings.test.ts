 
import { jest } from '@jest/globals';

// Mock electron
const mockHandle = jest.fn<(channel: string, handler: (...args: any[]) => any) => void>();
jest.mock('electron', () => ({
  app: {
    setLoginItemSettings: jest.fn(),
  },
  ipcMain: {
    handle: mockHandle,
  },
}));
// The sender check has tests of its own (trusted-ipc.test.ts); here the
// handlers are called directly, so they are registered on electron's ipcMain.
jest.mock('./trusted-ipc', () => ({ ipcMain: jest.requireMock<{ ipcMain: unknown }>('electron').ipcMain }));

// Mock dependencies
jest.mock('../config', () => ({
  loadConfig: jest.fn(),
  saveConfig: jest.fn(),
  // As in config.ts.
  SETTABLE_CONFIG_KEYS: [
    'runnerConfig', 'theme', 'launchAtLogin', 'hideOnStart', 'sleepProtection', 'logLevel',
    'runnerLogLevel', 'userFilter', 'maxConcurrentJobs', 'power', 'notifications',
  ],
}));

jest.mock('../app-state', () => ({
  setSleepProtectionSetting: jest.fn(),
  setLogLevelSetting: jest.fn(),
  setRunnerLogLevelSetting: jest.fn(),
  updateSleepProtection: jest.fn(),
  getResourceMonitor: jest.fn(),
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

import { app } from 'electron';
import { registerSettingsHandlers } from './settings';
import { store } from '../store';
import { loadConfig, saveConfig } from '../config';
import {
  setSleepProtectionSetting,
  setLogLevelSetting,
  setRunnerLogLevelSetting,
  updateSleepProtection,
} from '../app-state';

describe('settings IPC handlers', () => {
  let handlers: Record<string, (...args: any[]) => any>;

  beforeEach(() => {
    jest.clearAllMocks();
    handlers = {};

    // Capture the handlers when registered
    mockHandle.mockImplementation((channel, handler) => {
      handlers[channel] = handler;
    });

    (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValue({
      theme: 'auto',
    } as any);

    registerSettingsHandlers();
  });

  describe('settings:get', () => {
    it('should register handler', () => {
      expect(handlers['settings:get']).toBeDefined();
    });

    it('never hands the renderer the stored session', () => {
      (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValue({
        theme: 'dark',
        auth: { refreshToken: 'ghr_secret', user: { login: 'octocat' } },
      } as any);

      expect(handlers['settings:get']()).toEqual({ theme: 'dark' });
    });

    it('should return current config', () => {
      (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValue({
        theme: 'dark',
        sleepProtection: 'when-busy',
      } as any);

      const result = handlers['settings:get']();

      expect(result).toEqual({
        theme: 'dark',
        sleepProtection: 'when-busy',
      });
    });
  });

  describe('settings:set', () => {
    it('should register handler', () => {
      expect(handlers['settings:set']).toBeDefined();
    });

    it('should save allowed settings', () => {
      (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValue({ theme: 'auto' } as any);

      const result = handlers['settings:set']({}, { theme: 'dark' });

      expect(saveConfig).toHaveBeenCalledWith({ theme: 'dark' });
      expect(result).toEqual({ success: true });
    });

    it('should filter out non-settable keys', () => {
      (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValue({} as any);

      handlers['settings:set']({}, {
        theme: 'dark',
        dangerousKey: 'malicious',
        auth: { token: 'stolen' },
      });

      expect(saveConfig).toHaveBeenCalledWith({ theme: 'dark' });
    });

    it('should update sleep protection when changed', () => {
      (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValue({} as any);

      handlers['settings:set']({}, { sleepProtection: 'always' });

      expect(setSleepProtectionSetting).toHaveBeenCalledWith('always');
      expect(updateSleepProtection).toHaveBeenCalled();
    });

    it('should update log level when changed', () => {
      (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValue({} as any);

      handlers['settings:set']({}, { logLevel: 'debug' });

      expect(setLogLevelSetting).toHaveBeenCalledWith('debug');
    });

    it('should update runner log level when changed', () => {
      (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValue({} as any);

      handlers['settings:set']({}, { runnerLogLevel: 'error' });

      expect(setRunnerLogLevelSetting).toHaveBeenCalledWith('error');
    });

    it('should update login items when launchAtLogin changed', () => {
      (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValue({} as any);

      handlers['settings:set']({}, { launchAtLogin: true });

      expect(app.setLoginItemSettings).toHaveBeenCalledWith({
        openAtLogin: true,
        openAsHidden: false,
      });
    });

    it('saves only values of the shape each setting has, and refuses the rest', () => {
      (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValue({ theme: 'light', logLevel: 'info' } as any);
      const valid = {
        runnerConfig: { level: 'repo', repoUrl: 'https://github.com/o/r', runnerName: 'mac', labels: 'a,b', runnerCount: 4 },
        hideOnStart: false,
        userFilter: { scope: 'trigger', allowedUsers: 'allowlist', allowlist: [{ login: 'octocat', avatar_url: 'https://x', name: null }] },
        maxConcurrentJobs: 2,
        power: { pauseOnBattery: '<25%', pauseOnVideoCall: true, videoCallGracePeriod: 60 },
        notifications: { notifyOnPause: true, notifyOnJobEvents: false },
      };

      const result = handlers['settings:set']({}, {
        ...valid,
        theme: 'neon',
        logLevel: { level: 'debug' },
        runnerLogLevel: 'trace',
        sleepProtection: 42,
        launchAtLogin: 'yes',
      });

      expect(saveConfig).toHaveBeenCalledWith({ theme: 'light', logLevel: 'info', ...valid });
      expect(result).toEqual({
        success: false,
        error: 'Refused settings of the wrong shape: theme, launchAtLogin, sleepProtection, logLevel, runnerLogLevel',
      });
      expect(setLogLevelSetting).not.toHaveBeenCalled();
      expect(setRunnerLogLevelSetting).not.toHaveBeenCalled();
      expect(setSleepProtectionSetting).not.toHaveBeenCalled();
      expect(app.setLoginItemSettings).not.toHaveBeenCalled();
      expect(store.getState().config.maxConcurrentJobs).toBe(2);
    });

    it('refuses nested values that are not what the setting holds', () => {
      (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValue({} as any);

      for (const settings of [
        { runnerConfig: { level: 'enterprise' } },
        { runnerConfig: { level: 'repo', runnerCount: 1e9 } },
        { runnerConfig: { level: 'repo', repoUrl: 'https://github.com/o/r', extra: true } },
        { userFilter: { scope: 'trigger', allowedUsers: 'allowlist', allowlist: [{ login: '../x', avatar_url: '', name: null }] } },
        { userFilter: { scope: 'everyone', allowedUsers: 'just-me', allowlist: 'octocat' } },
        { maxConcurrentJobs: 1e9 },
        { maxConcurrentJobs: 2.5 },
        { power: { pauseOnBattery: 'sometimes', pauseOnVideoCall: false, videoCallGracePeriod: 60 } },
        { power: { pauseOnBattery: 'never', pauseOnVideoCall: false, videoCallGracePeriod: -1 } },
        { notifications: { notifyOnPause: 'true', notifyOnJobEvents: false } },
      ]) {
        const result = handlers['settings:set']({}, settings);
        expect({ settings, success: result.success }).toEqual({ settings, success: false });
      }
      expect(saveConfig).not.toHaveBeenCalledWith(expect.objectContaining({ runnerConfig: expect.anything() }));
      expect(saveConfig).not.toHaveBeenCalledWith(expect.objectContaining({ userFilter: expect.anything() }));
      expect(saveConfig).not.toHaveBeenCalledWith(expect.objectContaining({ maxConcurrentJobs: expect.anything() }));
      expect(saveConfig).not.toHaveBeenCalledWith(expect.objectContaining({ power: expect.anything() }));
      expect(saveConfig).not.toHaveBeenCalledWith(expect.objectContaining({ notifications: expect.anything() }));
    });

    it('takes a runner owner and repository only as GitHub names, or empty', () => {
      (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValue({} as any);
      // With no targets saved, these become the target's owner and repo, and
      // the repository URL is the job link.
      for (const runnerConfig of [
        { level: 'org', orgName: '../x' },
        { level: 'repo', repoUrl: 'https://github.com/../x' },
        { level: 'repo', repoUrl: 'https://github.com/o/r/../../x' },
        { level: 'repo', repoUrl: 'https://evil.example/o/r' },
        // The job link is this string as it is, so only GitHub's own form of
        // it is kept, the one the setup wizard offers: no clone suffix, no
        // trailing slash.
        { level: 'repo', repoUrl: 'https://github.com/o/r.git' },
        { level: 'repo', repoUrl: 'https://github.com/o/r/' },
      ]) {
        const result = handlers['settings:set']({}, { runnerConfig });
        expect({ runnerConfig, success: result.success }).toEqual({ runnerConfig, success: false });
      }
      expect(saveConfig).not.toHaveBeenCalledWith(expect.objectContaining({ runnerConfig: expect.anything() }));

      for (const runnerConfig of [
        { level: 'org', orgName: 'acme', repoUrl: '' },
        { level: 'repo', orgName: '', repoUrl: 'https://github.com/o/my.repo' },
        // An owner only older accounts can have: the page sends the saved
        // runnerConfig back with every change to it, so refusing this URL
        // would refuse every later change to the runner's count or labels.
        { level: 'repo', orgName: '', repoUrl: 'https://github.com/old-name-/r' },
        // And an organization of that age, for the same reason.
        { level: 'org', orgName: 'old-org-', repoUrl: '' },
      ]) {
        expect(handlers['settings:set']({}, { runnerConfig })).toEqual({ success: true });
        expect(saveConfig).toHaveBeenLastCalledWith({ runnerConfig });
      }
    });

    it('keeps an allowlist that holds a login only older accounts can have', () => {
      // GitHub once issued logins such as a trailing hyphen, which a new
      // account cannot take. The page sends the whole list back on every
      // change, so refusing one saved entry would refuse every change after.
      (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValue({} as any);
      const userFilter = {
        scope: 'trigger',
        allowedUsers: 'allowlist',
        allowlist: [{ login: 'old-name-', avatar_url: '', name: null }],
      };
      expect(handlers['settings:set']({}, { userFilter })).toEqual({ success: true });
      expect(saveConfig).toHaveBeenCalledWith({ userFilter });
    });

    it('never writes targets, which only the target manager changes', () => {
      (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValue({} as any);
      const before = store.getState().config.targets;

      handlers['settings:set']({}, {
        theme: 'dark',
        targets: [{ id: 'x', type: 'repo', owner: '../x', repo: 'y', displayName: 'x', url: 'https://evil.example' }],
      });

      expect(saveConfig).toHaveBeenCalledWith({ theme: 'dark' });
      expect(store.getState().config.targets).toBe(before);
    });

    it('should merge with existing config', () => {
      (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValue({
        theme: 'light',
        sleepProtection: 'never',
      } as any);

      handlers['settings:set']({}, { theme: 'dark' });

      expect(saveConfig).toHaveBeenCalledWith({
        theme: 'dark',
        sleepProtection: 'never',
      });
    });
  });
});
