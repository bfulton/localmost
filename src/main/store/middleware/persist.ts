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
import { bootLog } from '../../log-file';
import { store, getState } from '../index';
import { ConfigSlice, defaultConfigState } from '../types';
import { AppConfig, CONFIG_VERSION, isConfigFromNewerBuild } from '../../config';
import { resolveJobEnvironmentConfig, resolveResourcePauseConfig } from '../../../shared/job-preferences';
import { resolveIsolationConfig } from '../../../shared/isolation';

// Debounce timer for persistence
let persistTimer: NodeJS.Timeout | null = null;
const PERSIST_DEBOUNCE_MS = 500;

// Track if we're currently loading to avoid save loops
let isLoading = false;

// Set when the config on disk must not be overwritten: it could not be read or
// parsed (a truncated file left by an interrupted write, say), or it was written
// by a newer build. While this is true we refuse to persist, so a transient bad
// read or an older bundle can never turn into a permanent overwrite.
let saveBlocked = false;

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
  'toolCacheLocation',
  'userFilter',
  'sandboxPolicyLevel',
  'power',
  'notifications',
  'resourcePause',
  'jobEnvironment',
  'isolation',
  'launchAtLogin',
  'hideOnStart',
  'runnerConfig',
  'targets',
  'maxConcurrentJobs',
];

/**
 * Who writes each key of config.yaml at a save:
 *
 * - `store`: the store, from its own value (PERSISTED_CONFIG_KEYS).
 * - `file`: nobody; the file alone holds it, and this writer carries it
 *   forward as written - the Docker VM sizes (read with resolveDockerVmConfig
 *   at each worker spawn), the update check, and the OAuth client.
 * - `auth`: the auth module, whose fields this writer copies forward.
 * - `version`: this writer, stamping CONFIG_VERSION.
 *
 * Every key of AppConfig, and a key the store also holds can only be the
 * store's, so a key added to AppConfig without saying who writes it fails to
 * compile. dockerVm was added without telling this writer, and every save -
 * on each config change, and at quit - rebuilt the file without it, dropping
 * what was written there by hand. A key an earlier build wrote and AppConfig
 * no longer has (preserveWorkDir) still goes at the next save.
 */
const CONFIG_KEY_OWNER: {
  readonly [K in keyof AppConfig]-?: K extends keyof ConfigSlice ? 'store' : 'file' | 'auth' | 'version';
} = {
  configVersion: 'version',
  githubClientId: 'file',
  auth: 'auth',
  runnerConfig: 'store',
  theme: 'store',
  launchAtLogin: 'store',
  hideOnStart: 'store',
  sleepProtection: 'store',
  logLevel: 'store',
  runnerLogLevel: 'store',
  userFilter: 'store',
  updateSettings: 'file',
  targets: 'store',
  maxConcurrentJobs: 'store',
  power: 'store',
  notifications: 'store',
  dockerVm: 'file',
  resourcePause: 'store',
  jobEnvironment: 'store',
  isolation: 'store',
};

/** The sections of config.yaml only the file holds, carried forward at each save (see CONFIG_KEY_OWNER). */
const FILE_ONLY_CONFIG_KEYS = (Object.keys(CONFIG_KEY_OWNER) as Array<keyof AppConfig>).filter(
  (key) => CONFIG_KEY_OWNER[key] === 'file'
);

/**
 * Load persisted config from YAML file into the store.
 */
export function loadPersistedConfig(): void {
  isLoading = true;
  saveBlocked = false;

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

    // The file exists but yielded nothing usable — almost always a truncated
    // or corrupted write. Do NOT fall through to applying an empty config and
    // then saving defaults over it; that is how a recoverable glitch becomes
    // permanent data loss. Refuse to persist until a good load succeeds.
    if (!diskConfig || Object.keys(diskConfig).length === 0) {
      saveBlocked = true;
      bootLog('error', `Config at ${configPath} exists but parsed to nothing; refusing to overwrite it with defaults`);
      return;
    }

    // Written by a newer build than this one. Apply what we understand so the
    // session still reflects the user's settings, but block saving so this
    // (older) build cannot downgrade and lose fields it doesn't know about.
    if (isConfigFromNewerBuild(diskConfig.configVersion)) {
      saveBlocked = true;
      bootLog('error', `Config at ${configPath} was written by a newer build (version ${diskConfig.configVersion} > ${CONFIG_VERSION}); refusing to overwrite it`);
    }

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

    // User filter - supports both old 'mode' format and new 'scope/allowedUsers' format
    if (diskConfig.userFilter) {
      const filter = diskConfig.userFilter;
      const allowlist = Array.isArray(filter.allowlist) ? filter.allowlist : [];

      // Check for new format first
      if (filter.scope && ['everyone', 'trigger', 'contributors'].includes(filter.scope)) {
        configUpdates.userFilter = {
          scope: filter.scope,
          allowedUsers: filter.allowedUsers || 'just-me',
          allowlist,
        };
      } else if (filter.mode && ['everyone', 'just-me', 'allowlist'].includes(filter.mode)) {
        // Migrate from old format to new format
        // Old format mapping:
        //   'everyone' -> scope: 'everyone', allowedUsers: 'just-me' (doesn't matter, not used)
        //   'just-me' -> scope: 'trigger', allowedUsers: 'just-me'
        //   'allowlist' -> scope: 'trigger', allowedUsers: 'allowlist'
        let scope: 'everyone' | 'trigger' | 'contributors' = 'everyone';
        let allowedUsers: 'just-me' | 'allowlist' = 'just-me';

        if (filter.mode === 'just-me') {
          scope = 'trigger';
          allowedUsers = 'just-me';
        } else if (filter.mode === 'allowlist') {
          scope = 'trigger';
          allowedUsers = 'allowlist';
        }

        configUpdates.userFilter = { scope, allowedUsers, allowlist };
        bootLog('info', `Migrated userFilter from mode='${filter.mode}' to scope='${scope}', allowedUsers='${allowedUsers}'`);
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

    // What a resource pause does, and the job-environment conveniences: as
    // the runner reads them at each pause and spawn, so a value it would
    // take as absent loads as the default it uses instead.
    if (diskConfig.resourcePause !== undefined) {
      configUpdates.resourcePause = resolveResourcePauseConfig(diskConfig.resourcePause, (message) => bootLog('warn', message));
    }
    if (diskConfig.jobEnvironment !== undefined) {
      configUpdates.jobEnvironment = resolveJobEnvironmentConfig(diskConfig.jobEnvironment, (message) => bootLog('warn', message));
    }
    // Which isolation types this Mac allows, as admission reads them.
    if (diskConfig.isolation !== undefined) {
      configUpdates.isolation = resolveIsolationConfig(diskConfig.isolation, (message) => bootLog('warn', message));
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

    // Auth is handled by index.ts during startup - not by persist middleware
    // This avoids duplicate config reads and keeps auth logic centralized

    bootLog('info', 'Loaded config from disk');
  } catch (e) {
    // A file we could not read is not the same as no file. Treat it like a
    // failed parse: keep the on-disk copy, refuse to overwrite it.
    saveBlocked = true;
    bootLog('error', `Failed to load config, refusing to overwrite it: ${(e as Error).message}`);
  } finally {
    isLoading = false;
  }
}

/**
 * Save current config state to disk.
 * Uses atomic write (temp file + rename) to prevent corruption.
 * Preserves auth section from existing config (auth is saved separately by auth module).
 */
export function savePersistedConfig(): void {
  if (isLoading) {
    return;
  }

  // The load marked the on-disk config off-limits (unreadable, or from a newer
  // build). Persisting now would stamp this build's view over it, making any
  // loss permanent. Stay our hand until a good load from a compatible file resets this.
  if (saveBlocked) {
    bootLog('error', 'Skipping config save: the on-disk config is unreadable or from a newer build; refusing to overwrite it');
    return;
  }

  try {
    const configPath = getConfigPath();
    const configDir = getAppDataDir();
    const state = getState();

    // Build config object from store state
    const configToSave: Record<string, unknown> = { configVersion: CONFIG_VERSION };

    // Copy persisted keys
    for (const key of PERSISTED_CONFIG_KEYS) {
      const value = state.config[key];
      if (value !== undefined) {
        configToSave[key] = value;
      }
    }

    // Preserve auth from existing config file (auth is saved separately by auth module)
    // We must read and preserve it to avoid overwriting encrypted tokens, and
    // the sections only the file holds with it
    if (fs.existsSync(configPath)) {
      try {
        const existingContent = fs.readFileSync(configPath, 'utf-8');
        const existingConfig = (yaml.load(existingContent, { schema: yaml.JSON_SCHEMA }) as AppConfig) || {};
        for (const key of FILE_ONLY_CONFIG_KEYS) {
          if (existingConfig[key] !== undefined) configToSave[key] = existingConfig[key];
        }
        // Copy forward only the fields we intend to persist. Copying the
        // section verbatim would keep a legacy accessToken/expiresAt written by
        // an older build on disk forever, which is exactly what
        // "access tokens are never written to disk" promises not to happen.
        const existingAuth = existingConfig.auth;
        if (existingAuth?.refreshToken) {
          configToSave.auth = {
            refreshToken: existingAuth.refreshToken,
            user: existingAuth.user,
            // Whether the session is spent is written by the auth module
            // (saveConfig). This writer runs on every config change and on
            // quit; rebuilding auth without it made every launch forget the
            // session was dead and refresh a token that can never work.
            ...(existingAuth.expired ? { expired: true } : {}),
          };
        }
      } catch (readErr) {
        bootLog('warn', `Failed to read existing config for auth preservation: ${(readErr as Error).message}`);
      }
    }

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
