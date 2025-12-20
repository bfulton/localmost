/* eslint-disable @typescript-eslint/no-explicit-any */
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

// Mock dependencies
jest.mock('../config', () => ({
  loadConfig: jest.fn(),
  saveConfig: jest.fn(),
  SETTABLE_CONFIG_KEYS: ['theme', 'sleepProtection', 'logLevel', 'runnerLogLevel', 'launchAtLogin'],
}));

jest.mock('../app-state', () => ({
  setSleepProtectionSetting: jest.fn(),
  setLogLevelSetting: jest.fn(),
  setRunnerLogLevelSetting: jest.fn(),
  updateSleepProtection: jest.fn(),
}));

import { app } from 'electron';
import { registerSettingsHandlers } from './settings';
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
