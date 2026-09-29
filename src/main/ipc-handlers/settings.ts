/**
 * IPC handlers for settings management.
 */

import { app } from 'electron';
import { ipcMain } from './trusted-ipc';
import { loadConfig, saveConfig, SETTABLE_CONFIG_KEYS, SettableConfigKey, AppConfig } from '../config';
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
import { MAX_RUNNER_COUNT } from '../../shared/constants';
import { isGitHubLogin, isGitHubOwnerName, parseGitHubRepoUrl } from '../../shared/github-names';
import { isAllowedUsers, isFilterScope } from '../../shared/user-filter-config';

const log = () => getLogger();

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const oneOf = (...allowed: string[]) => (value: unknown): boolean =>
  typeof value === 'string' && allowed.includes(value);

const isBoolean = (value: unknown): boolean => typeof value === 'boolean';

const isString = (value: unknown): boolean => typeof value === 'string';

const isIntegerIn = (min: number, max: number) => (value: unknown): boolean =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

/**
 * An object with only the named fields, each of the shape given. Fields
 * listed as optional may be absent; the rest must be present.
 */
const isRecordOf = (
  fields: Record<string, (value: unknown) => boolean>,
  optional: ReadonlyArray<string> = []
) => (value: unknown): boolean => {
  if (!isPlainObject(value)) return false;
  if (Object.keys(value).some((key) => !Object.hasOwn(fields, key))) return false;
  return Object.entries(fields).every(([key, check]) =>
    Object.hasOwn(value, key) ? check(value[key]) : optional.includes(key)
  );
};

const LOG_LEVELS = oneOf('debug', 'info', 'warn', 'error');

/**
 * The shape of each setting the renderer may write. Every value is checked
 * before it is saved or reaches the store: these settings decide whose jobs
 * run here (userFilter), how many at once, and what the runner registers as,
 * and a value of the wrong shape is either a bug or someone else's script.
 */
const SETTING_SHAPES: Record<SettableConfigKey, (value: unknown) => boolean> = {
  runnerConfig: isRecordOf(
    {
      level: oneOf('repo', 'org'),
      // With no targets saved these are the runner's owner and repo, and the
      // URL is the job link, so they are GitHub names or empty.
      repoUrl: (value) => value === '' || parseGitHubRepoUrl(value) !== null,
      orgName: (value) => value === '' || isGitHubOwnerName(value),
      runnerName: isString,
      labels: isString,
      runnerCount: isIntegerIn(1, MAX_RUNNER_COUNT),
    },
    ['repoUrl', 'orgName', 'runnerName', 'labels', 'runnerCount']
  ),
  theme: oneOf('light', 'dark', 'auto'),
  launchAtLogin: isBoolean,
  hideOnStart: isBoolean,
  sleepProtection: oneOf('never', 'when-busy', 'always'),
  logLevel: LOG_LEVELS,
  runnerLogLevel: LOG_LEVELS,
  userFilter: isRecordOf({
    scope: isFilterScope,
    allowedUsers: isAllowedUsers,
    allowlist: (value) =>
      Array.isArray(value) &&
      value.every(
        isRecordOf({
          login: isGitHubLogin,
          avatar_url: isString,
          name: (name) => name === null || typeof name === 'string',
        })
      ),
  }),
  maxConcurrentJobs: isIntegerIn(1, MAX_RUNNER_COUNT),
  power: isRecordOf({
    pauseOnBattery: oneOf('never', '<25%', '<50%', '<75%', 'always'),
    pauseOnVideoCall: isBoolean,
    videoCallGracePeriod: (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  }),
  notifications: isRecordOf({ notifyOnPause: isBoolean, notifyOnJobEvents: isBoolean }),
};

/**
 * Register settings-related IPC handlers.
 */
export const registerSettingsHandlers = (): void => {
  // Settings. The stored session is not the renderer's: it holds the
  // decrypted refresh token, and the renderer learns who is signed in from
  // the store.
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, () => {
    const settings = loadConfig();
    delete settings.auth;
    return settings;
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (_event, settings: unknown) => {
    if (!isPlainObject(settings)) {
      return { success: false, error: 'Settings must be an object' };
    }
    // Only known settable keys, and only values of the shape each one has.
    // A refused value is left out and the saved one kept: the renderer
    // echoes back whatever settings:get returned, so one stale value must
    // not cost the rest of the write.
    const sanitizedSettings: Partial<AppConfig> = {};
    const refused: string[] = [];
    for (const key of SETTABLE_CONFIG_KEYS) {
      if (!Object.hasOwn(settings, key)) continue;
      if (SETTING_SHAPES[key](settings[key])) {
        (sanitizedSettings as Record<string, unknown>)[key] = settings[key];
      } else {
        refused.push(key);
      }
    }
    if (refused.length > 0) {
      log()?.warn(`[Settings] refused values of the wrong shape: ${refused.join(', ')}`);
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
        } else {
          log()?.info(`[Settings] ${key}: ${JSON.stringify(oldValue)} -> ${JSON.stringify(newValue)}`);
        }
      }
    }

    saveConfig({ ...current, ...sanitizedSettings });

    // Update Zustand store to sync with renderer via zubridge
    const storeState = store.getState();
    if (sanitizedSettings.theme !== undefined) {
      storeState.setTheme(sanitizedSettings.theme as ThemeSetting);
    }
    if (sanitizedSettings.logLevel !== undefined) {
      storeState.setLogLevel(sanitizedSettings.logLevel as LogLevel);
    }
    if (sanitizedSettings.runnerLogLevel !== undefined) {
      storeState.setRunnerLogLevel(sanitizedSettings.runnerLogLevel as LogLevel);
    }
    if (sanitizedSettings.sleepProtection !== undefined) {
      storeState.setSleepProtection(sanitizedSettings.sleepProtection as SleepProtection);
    }
    if (sanitizedSettings.userFilter !== undefined) {
      storeState.setUserFilter(sanitizedSettings.userFilter);
    }
    if (sanitizedSettings.power !== undefined) {
      storeState.setPower(sanitizedSettings.power);
    }
    if (sanitizedSettings.notifications !== undefined) {
      storeState.setNotifications(sanitizedSettings.notifications);
    }
    if (sanitizedSettings.launchAtLogin !== undefined) {
      storeState.setLaunchAtLogin(sanitizedSettings.launchAtLogin);
    }
    if (sanitizedSettings.hideOnStart !== undefined) {
      storeState.setHideOnStart(sanitizedSettings.hideOnStart);
    }
    if (sanitizedSettings.maxConcurrentJobs !== undefined) {
      storeState.setMaxConcurrentJobs(sanitizedSettings.maxConcurrentJobs);
    }
    if (sanitizedSettings.runnerConfig !== undefined) {
      storeState.updateRunnerConfig(sanitizedSettings.runnerConfig);
    }

    // Update sleep protection if setting changed
    if (sanitizedSettings.sleepProtection !== undefined) {
      setSleepProtectionSetting(sanitizedSettings.sleepProtection as SleepProtection);
      updateSleepProtection();
    }

    // Update log level if setting changed
    if (sanitizedSettings.logLevel !== undefined) {
      setLogLevelSetting(sanitizedSettings.logLevel as LogLevel);
    }

    // Update runner log level if setting changed
    if (sanitizedSettings.runnerLogLevel !== undefined) {
      setRunnerLogLevelSetting(sanitizedSettings.runnerLogLevel as LogLevel);
    }

    // Update launch at login if setting changed
    if (sanitizedSettings.launchAtLogin !== undefined) {
      app.setLoginItemSettings({
        openAtLogin: sanitizedSettings.launchAtLogin,
        openAsHidden: false,
      });
    }

    // Update power config if setting changed
    if (sanitizedSettings.power !== undefined) {
      const resourceMonitor = getResourceMonitor();
      if (resourceMonitor) {
        resourceMonitor.updateConfig(sanitizedSettings.power);
      }
    }

    if (refused.length > 0) {
      return { success: false, error: `Refused settings of the wrong shape: ${refused.join(', ')}` };
    }
    return { success: true };
  });
};
