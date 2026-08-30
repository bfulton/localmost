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
  getResourceMonitor,
  getLogger,
} from '../app-state';
import { IPC_CHANNELS, SleepProtection, LogLevel } from '../../shared/types';
import { store } from '../store';
import { ThemeSetting } from '../store/types';

const log = () => getLogger();

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

    // Log settings changes
    for (const key of Object.keys(sanitizedSettings) as Array<keyof typeof sanitizedSettings>) {
      const oldValue = current[key];
      const newValue = sanitizedSettings[key];
      // Only log if value actually changed (deep comparison for objects would be complex, so stringify)
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        // Don't log sensitive data, just the key and a summary
        if (key === 'userFilter' || key === 'power' || key === 'notifications') {
          log()?.info(`[Settings] ${key} updated`);
        } else if (key === 'targets') {
          const oldCount = Array.isArray(oldValue) ? oldValue.length : 0;
          const newCount = Array.isArray(newValue) ? newValue.length : 0;
          log()?.info(`[Settings] targets updated: ${oldCount} -> ${newCount} targets`);
        } else {
          log()?.info(`[Settings] ${key}: ${JSON.stringify(oldValue)} -> ${JSON.stringify(newValue)}`);
        }
      }
    }

    saveConfig({ ...current, ...sanitizedSettings });

    // Update Zustand store to sync with renderer via zubridge
    const storeState = store.getState();
    if (settings.theme !== undefined) {
      storeState.setTheme(settings.theme as ThemeSetting);
    }
    if (settings.logLevel !== undefined) {
      storeState.setLogLevel(settings.logLevel as LogLevel);
    }
    if (settings.runnerLogLevel !== undefined) {
      storeState.setRunnerLogLevel(settings.runnerLogLevel as LogLevel);
    }
    if (settings.sleepProtection !== undefined) {
      storeState.setSleepProtection(settings.sleepProtection as SleepProtection);
    }
    if (settings.userFilter !== undefined) {
      storeState.setUserFilter(settings.userFilter);
    }
    if (settings.power !== undefined) {
      storeState.setPower(settings.power);
    }
    if (settings.notifications !== undefined) {
      storeState.setNotifications(settings.notifications);
    }
    if (settings.launchAtLogin !== undefined) {
      storeState.setLaunchAtLogin(settings.launchAtLogin);
    }
    if (settings.hideOnStart !== undefined) {
      storeState.setHideOnStart(settings.hideOnStart);
    }
    if (settings.targets !== undefined) {
      storeState.setTargets(settings.targets);
    }
    if (settings.maxConcurrentJobs !== undefined) {
      storeState.setMaxConcurrentJobs(settings.maxConcurrentJobs);
    }
    if (settings.runnerConfig !== undefined) {
      storeState.updateRunnerConfig(settings.runnerConfig);
    }

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

    // Update power config if setting changed
    if (settings.power !== undefined) {
      const resourceMonitor = getResourceMonitor();
      if (resourceMonitor) {
        resourceMonitor.updateConfig(settings.power);
      }
    }

    return { success: true };
  });
};
