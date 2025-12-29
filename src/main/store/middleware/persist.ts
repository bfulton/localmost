/**
 * YAML persistence middleware for Zustand store.
 *
 * Handles loading config from disk on startup and saving changes with debouncing.
 * Uses atomic writes (temp file + rename) to prevent corruption.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { getAppDataDir, getConfigPath } from '../../paths';
import { encryptValue, decryptValue } from '../../encryption';
import { bootLog } from '../../log-file';
import { store, getState } from '../index';
import { ConfigSlice, defaultConfigState } from '../types';
import { AppConfig } from '../../config';

// Debounce timer for persistence
let persistTimer: NodeJS.Timeout | null = null;
const PERSIST_DEBOUNCE_MS = 500;

// Track if we're currently loading to avoid save loops
let isLoading = false;

/**
 * Keys from ConfigSlice that should be persisted to disk.
 * Auth tokens are handled separately with encryption.
 */
const PERSISTED_CONFIG_KEYS: (keyof ConfigSlice)[] = [
  'theme',
  'logLevel',
  'runnerLogLevel',
  'maxLogScrollback',
  'maxJobHistory',
  'sleepProtection',
  'sleepProtectionConsented',
  'preserveWorkDir',
  'toolCacheLocation',
  'userFilter',
  'power',
  'notifications',
  'launchAtLogin',
  'hideOnStart',
  'runnerConfig',
  'targets',
  'maxConcurrentJobs',
];

/**
 * Load persisted config from YAML file into the store.
 */
export function loadPersistedConfig(): void {
  isLoading = true;

  try {
    const configPath = getConfigPath();
    const configDir = getAppDataDir();

    // Check for old JSON config and migrate
    const oldJsonPath = path.join(configDir, 'config.json');
    if (fs.existsSync(oldJsonPath) && !fs.existsSync(configPath)) {
      try {
        const jsonContent = fs.readFileSync(oldJsonPath, 'utf-8');
        const config = JSON.parse(jsonContent) as AppConfig;
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(configPath, yaml.dump(config, { indent: 2, lineWidth: -1 }));
        fs.unlinkSync(oldJsonPath);
        bootLog('info', 'Migrated config from JSON to YAML');
      } catch (e) {
        bootLog('warn', `Failed to migrate JSON config: ${(e as Error).message}`);
      }
    }

    // Load from YAML config file
    if (!fs.existsSync(configPath)) {
      bootLog('info', 'No config file found, using defaults');
      isLoading = false;
      return;
    }

    const yamlContent = fs.readFileSync(configPath, 'utf-8');
    const diskConfig = (yaml.load(yamlContent, { schema: yaml.JSON_SCHEMA }) as AppConfig) || {};

    // Map disk config to store state
    const configUpdates: Partial<ConfigSlice> = {};

    // Theme
    if (diskConfig.theme && ['light', 'dark', 'auto'].includes(diskConfig.theme)) {
      configUpdates.theme = diskConfig.theme as ConfigSlice['theme'];
    }

    // Log levels
    if (diskConfig.logLevel && ['debug', 'info', 'warn', 'error'].includes(diskConfig.logLevel)) {
      configUpdates.logLevel = diskConfig.logLevel;
    }
    if (diskConfig.runnerLogLevel && ['debug', 'info', 'warn', 'error'].includes(diskConfig.runnerLogLevel)) {
      configUpdates.runnerLogLevel = diskConfig.runnerLogLevel;
    }

    // Sleep protection
    if (diskConfig.sleepProtection && ['never', 'when-busy', 'always'].includes(diskConfig.sleepProtection)) {
      configUpdates.sleepProtection = diskConfig.sleepProtection;
    }

    // Preserve work dir
    if (diskConfig.preserveWorkDir && ['never', 'always'].includes(diskConfig.preserveWorkDir)) {
      configUpdates.preserveWorkDir = diskConfig.preserveWorkDir;
    }

    // User filter
    if (diskConfig.userFilter) {
      const filter = diskConfig.userFilter;
      if (filter.mode && ['everyone', 'just-me', 'allowlist'].includes(filter.mode)) {
        configUpdates.userFilter = {
          mode: filter.mode,
          allowlist: Array.isArray(filter.allowlist) ? filter.allowlist : [],
        };
      }
    }

    // Power settings
    if (diskConfig.power) {
      configUpdates.power = {
        ...defaultConfigState.power,
        ...diskConfig.power,
      };
    }

    // Notifications
    if (diskConfig.notifications) {
      configUpdates.notifications = {
        ...defaultConfigState.notifications,
        ...diskConfig.notifications,
      };
    }

    // Runner config
    if (diskConfig.runnerConfig) {
      configUpdates.runnerConfig = {
        ...defaultConfigState.runnerConfig,
        level: diskConfig.runnerConfig.level || defaultConfigState.runnerConfig.level,
        repoUrl: diskConfig.runnerConfig.repoUrl || '',
        orgName: diskConfig.runnerConfig.orgName || '',
        runnerName: diskConfig.runnerConfig.runnerName || '',
        labels: diskConfig.runnerConfig.labels || defaultConfigState.runnerConfig.labels,
        runnerCount: diskConfig.runnerConfig.runnerCount || defaultConfigState.runnerConfig.runnerCount,
      };
    }

    // Targets
    if (Array.isArray(diskConfig.targets)) {
      configUpdates.targets = diskConfig.targets;
    }

    // Max concurrent jobs
    if (typeof diskConfig.maxConcurrentJobs === 'number') {
      configUpdates.maxConcurrentJobs = diskConfig.maxConcurrentJobs;
    }

    // Boolean flags
    if (typeof diskConfig.launchAtLogin === 'boolean') {
      configUpdates.launchAtLogin = diskConfig.launchAtLogin;
    }
    if (typeof diskConfig.hideOnStart === 'boolean') {
      configUpdates.hideOnStart = diskConfig.hideOnStart;
    }

    // Apply updates to store
    if (Object.keys(configUpdates).length > 0) {
      store.setState((state) => ({
        config: { ...state.config, ...configUpdates },
      }));
    }

    // Handle auth tokens separately (with decryption)
    if (diskConfig.auth) {
      try {
        const accessToken = decryptValue(diskConfig.auth.accessToken);
        const refreshToken = diskConfig.auth.refreshToken
          ? decryptValue(diskConfig.auth.refreshToken)
          : undefined;

        store.setState((state) => ({
          auth: {
            ...state.auth,
            user: diskConfig.auth!.user,
            isAuthenticated: true,
          },
        }));

        // Store decrypted tokens in a separate location (not in Zustand for security)
        // The auth-tokens module handles this
      } catch (e) {
        bootLog('warn', `Failed to decrypt auth tokens: ${(e as Error).message}`);
      }
    }

    bootLog('info', 'Loaded config from disk');
  } catch (e) {
    bootLog('warn', `Failed to load config: ${(e as Error).message}`);
  } finally {
    isLoading = false;
  }
}

/**
 * Save current config state to disk.
 * Uses atomic write (temp file + rename) to prevent corruption.
 */
export function savePersistedConfig(): void {
  if (isLoading) {
    return;
  }

  try {
    const configPath = getConfigPath();
    const configDir = getAppDataDir();
    const state = getState();

    // Build config object from store state
    const configToSave: Record<string, unknown> = {};

    // Copy persisted keys
    for (const key of PERSISTED_CONFIG_KEYS) {
      const value = state.config[key];
      if (value !== undefined) {
        configToSave[key] = value;
      }
    }

    // Auth is handled separately by auth-tokens module
    // We don't save it here to avoid conflicts

    // Ensure directory exists
    fs.mkdirSync(configDir, { recursive: true });

    // Atomic write: write to temp file, then rename
    const tempPath = `${configPath}.tmp`;
    const yamlContent = yaml.dump(configToSave, { indent: 2, lineWidth: -1 });
    fs.writeFileSync(tempPath, yamlContent);
    fs.renameSync(tempPath, configPath);

    bootLog('debug', 'Saved config to disk');
  } catch (e) {
    bootLog('error', `Failed to save config: ${(e as Error).message}`);
  }
}

/**
 * Debounced save - called when config changes.
 */
function debouncedSave(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    savePersistedConfig();
    persistTimer = null;
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Subscribe to config changes and persist them.
 */
export function setupPersistence(): () => void {
  // Load initial config
  loadPersistedConfig();

  // Subscribe to config changes
  const unsubscribe = store.subscribe(
    (state) => state.config,
    () => {
      debouncedSave();
    },
    { equalityFn: Object.is }
  );

  return unsubscribe;
}

/**
 * Force an immediate save (e.g., before app quit).
 */
export function flushPersistence(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  savePersistedConfig();
}
