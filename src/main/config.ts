/**
 * Configuration management: loading, saving, and type definitions.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { getAppDataDir, getConfigPath } from './paths';
import { encryptValue, decryptValue } from './encryption';
import { bootLog } from './log-file';
import { GitHubUser, SleepProtection, LogLevel, UserFilterConfig, Target } from '../shared/types';

// Config paths - uses centralized path management
const configDir = getAppDataDir();
const configPath = getConfigPath();

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
] as const;

export type SettableConfigKey = typeof SETTABLE_CONFIG_KEYS[number];

export interface AppConfig {
  githubClientId?: string;
  auth?: {
    accessToken: string;
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
    runnerCount?: number;  // Number of parallel runners (1-16)
  };
  theme?: string;
  launchAtLogin?: boolean;
  hideOnStart?: boolean;
  sleepProtection?: SleepProtection;
  logLevel?: LogLevel;
  runnerLogLevel?: LogLevel;
  preserveWorkDir?: 'always' | 'never';
  userFilter?: UserFilterConfig;
  /** Multi-target configuration - list of repos/orgs to register runners for */
  targets?: Target[];
  /** Maximum concurrent jobs across all targets (1-16, defaults to 4) */
  maxConcurrentJobs?: number;
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
  if (config.auth) {
    try {
      config.auth.accessToken = decryptValue(config.auth.accessToken);
      if (config.auth.refreshToken) {
        config.auth.refreshToken = decryptValue(config.auth.refreshToken);
      }
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

    // Create a copy to avoid mutating the original config
    const configToSave = { ...config };

    // Encrypt sensitive auth data before saving
    if (configToSave.auth) {
      configToSave.auth = {
        ...configToSave.auth,
        accessToken: encryptValue(configToSave.auth.accessToken),
      };
      if (configToSave.auth.refreshToken) {
        configToSave.auth.refreshToken = encryptValue(configToSave.auth.refreshToken);
      }
    }

    fs.writeFileSync(configPath, yaml.dump(configToSave, { indent: 2, lineWidth: -1 }));
  } catch (e) {
    bootLog('error', `Failed to save config: ${(e as Error).message}`);
  }
};

/**
 * Get config directory path.
 */
export const getConfigDir = (): string => configDir;
