/**
 * Configuration management: loading, saving, and type definitions.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { getAppDataDir, getConfigPath } from './paths';
import { encryptValue, decryptValue } from './encryption';
import { bootLog } from './log-file';
import { GitHubUser, SleepProtection, LogLevel, UserFilterConfig, Target, PowerConfig, NotificationsConfig, UpdateSettings } from '../shared/types';

// Config paths - uses centralized path management
const configDir = getAppDataDir();
const configPath = getConfigPath();

/**
 * On-disk config format version. Bump when the format changes in a way an older
 * build would mishandle. Every save stamps this; loaders/savers refuse to write
 * over a file that carries a HIGHER version, so a stale or older app bundle
 * sharing the same config dir cannot silently downgrade (and lose) it.
 */
export const CONFIG_VERSION = 1;

/**
 * True when a config on disk was written by a newer build than this one.
 * An absent or non-numeric version is legacy, not newer.
 */
export const isConfigFromNewerBuild = (version: unknown): boolean =>
  typeof version === 'number' && version > CONFIG_VERSION;

/**
 * Keys that can be set via the SETTINGS_SET IPC handler.
 * This is the source of truth - TypeScript derives the type from this array.
 * Note: 'auth' and 'githubClientId' are intentionally excluded (set via auth flow).
 */
export const SETTABLE_CONFIG_KEYS = [
  'runnerConfig',
  'theme',
  'launchAtLogin',
  'hideOnStart',
  'sleepProtection',
  'logLevel',
  'runnerLogLevel',
  'userFilter',
  'targets',
  'maxConcurrentJobs',
  'power',  // Power settings (battery/video call pausing)
  'notifications',
] as const;

export type SettableConfigKey = typeof SETTABLE_CONFIG_KEYS[number];

export interface AppConfig {
  /** On-disk config format version. Used to refuse downgrades by an older build. */
  configVersion?: number;
  githubClientId?: string;
  auth?: {
    accessToken?: string;  // Optional - obtained fresh on startup, not persisted
    refreshToken?: string;
    expiresAt?: number;  // Unix timestamp (ms) when access token expires
    user: GitHubUser;
  };
  runnerConfig?: {
    level: 'repo' | 'org';
    repoUrl?: string;
    orgName?: string;
    runnerName?: string;
    labels?: string;
    runnerCount?: number;  // Number of parallel runners (1-8)
  };
  theme?: string;
  launchAtLogin?: boolean;
  hideOnStart?: boolean;
  sleepProtection?: SleepProtection;
  logLevel?: LogLevel;
  runnerLogLevel?: LogLevel;
  preserveWorkDir?: 'always' | 'never';
  userFilter?: UserFilterConfig;
  /** Sandbox policy level for all restrictions. Defaults to 'strict' */
  /** Auto-update preferences */
  updateSettings?: UpdateSettings;
  /** Multi-target configuration - list of repos/orgs to register runners for */
  targets?: Target[];
  /** Maximum concurrent jobs across all targets (1-8, defaults to 4) */
  maxConcurrentJobs?: number;
  /** Power settings (battery/video call pausing) */
  power?: PowerConfig;
  /** Notification settings */
  notifications?: NotificationsConfig;
}

/**
 * Load configuration from YAML file with decryption.
 */
export const loadConfig = (): AppConfig => {
  let config: AppConfig = {};
  const oldJsonPath = path.join(configDir, 'config.json');

  // Migrate from old JSON config if it exists and YAML doesn't
  if (fs.existsSync(oldJsonPath) && !fs.existsSync(configPath)) {
    try {
      const jsonContent = fs.readFileSync(oldJsonPath, 'utf-8');
      config = JSON.parse(jsonContent) as AppConfig;
      // Save as YAML
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, yaml.dump(config, { indent: 2, lineWidth: -1 }));
      // Remove old JSON file
      fs.unlinkSync(oldJsonPath);
      bootLog('info', 'Migrated config from JSON to YAML');
    } catch (e) {
      bootLog('warn', `Failed to migrate JSON config: ${(e as Error).message}`);
    }
  }

  // Load from YAML config file
  try {
    if (fs.existsSync(configPath)) {
      const yamlContent = fs.readFileSync(configPath, 'utf-8');
      config = (yaml.load(yamlContent, { schema: yaml.JSON_SCHEMA }) as AppConfig) || {};
    }
  } catch (e) {
    bootLog('warn', `Failed to load YAML config: ${(e as Error).message}`);
  }

  // Decrypt sensitive auth data if present
  // We only persist refreshToken and user - access tokens are obtained fresh on startup
  if (config.auth) {
    try {
      if (config.auth.refreshToken) {
        config.auth.refreshToken = decryptValue(config.auth.refreshToken);
      }
      // Clear any persisted access token - we'll get a fresh one on startup
      delete config.auth.accessToken;
      delete config.auth.expiresAt;
    } catch (e) {
      bootLog('warn', `Failed to decrypt auth tokens: ${(e as Error).message}`);
      delete config.auth;
    }
  }

  return config;
};

/**
 * Save configuration to YAML file with encryption.
 */
export const saveConfig = (config: AppConfig): void => {
  try {
    fs.mkdirSync(configDir, { recursive: true });

    // Refuse to downgrade a config written by a newer build. Reading only the
    // version keeps this cheap and tolerant of an otherwise-unreadable file
    // (the atomic write below still replaces genuine corruption).
    if (fs.existsSync(configPath)) {
      try {
        const existing = yaml.load(fs.readFileSync(configPath, 'utf-8'), { schema: yaml.JSON_SCHEMA }) as AppConfig | undefined;
        if (existing && isConfigFromNewerBuild(existing.configVersion)) {
          bootLog('error', `Refusing to save config: on-disk version ${existing.configVersion} is newer than this build (${CONFIG_VERSION}); a downgrade would clobber it`);
          return;
        }
      } catch {
        // Unreadable existing config: not a version downgrade. Fall through and
        // let the normal (atomic) save replace it.
      }
    }

    // Create a copy to avoid mutating the original config
    const configToSave: AppConfig = { ...config, configVersion: CONFIG_VERSION };

    // Only persist refreshToken and user - access tokens are obtained fresh on startup
    if (configToSave.auth) {
      const { refreshToken, user } = configToSave.auth;
      if (refreshToken) {
        configToSave.auth = {
          refreshToken: encryptValue(refreshToken),
          user,
        };
      } else {
        // No refresh token means we can't persist auth
        delete configToSave.auth;
      }
    }

    // Atomic write: serialize to a temp file, then rename over the real one.
    // A rename is atomic, so a reader (or a second app instance) never sees a
    // half-written file, and a failure part-way through leaves the previous
    // config intact instead of truncating it in place.
    const tempPath = `${configPath}.tmp`;
    fs.writeFileSync(tempPath, yaml.dump(configToSave, { indent: 2, lineWidth: -1 }));
    fs.renameSync(tempPath, configPath);
  } catch (e) {
    bootLog('error', `Failed to save config: ${(e as Error).message}`);
  }
};

/**
 * Get config directory path.
 */
export const getConfigDir = (): string => configDir;
