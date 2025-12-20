/**
 * IPC handlers for settings management.
 */

import { app, ipcMain } from 'electron';
import { loadConfig, saveConfig, SETTABLE_CONFIG_KEYS, AppConfig } from '../config';
import {
  setSleepProtectionSetting,
  setLogLevelSetting,
  setRunnerLogLevelSetting,
  updateSleepProtection,
} from '../app-state';
import { IPC_CHANNELS, SleepProtection, LogLevel } from '../../shared/types';

/**
 * Register settings-related IPC handlers.
 */
export const registerSettingsHandlers = (): void => {
  // Settings
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, () => {
    return loadConfig();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (_event, settings: Partial<AppConfig>) => {
    // Security: Only allow known settable keys (prevents arbitrary property injection)
    const sanitizedSettings: Partial<AppConfig> = {};
    for (const key of SETTABLE_CONFIG_KEYS) {
      if (key in settings) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (sanitizedSettings as any)[key] = (settings as any)[key];
      }
    }

    const current = loadConfig();
    saveConfig({ ...current, ...sanitizedSettings });

    // Update sleep protection if setting changed
    if (settings.sleepProtection !== undefined) {
      setSleepProtectionSetting(settings.sleepProtection as SleepProtection);
      updateSleepProtection();
    }

    // Update log level if setting changed
    if (settings.logLevel !== undefined) {
      setLogLevelSetting(settings.logLevel as LogLevel);
    }

    // Update runner log level if setting changed
    if (settings.runnerLogLevel !== undefined) {
      setRunnerLogLevelSetting(settings.runnerLogLevel as LogLevel);
    }

    // Update launch at login if setting changed
    if (settings.launchAtLogin !== undefined) {
      app.setLoginItemSettings({
        openAtLogin: settings.launchAtLogin,
        openAsHidden: false,
      });
    }

    return { success: true };
  });
};
