/**
 * Centralized application state management.
 * All mutable global state lives here with typed getters/setters.
 *
 * Runner state is now managed by XState - see runner-state-service.ts
 */

import { BrowserWindow, powerSaveBlocker } from 'electron';
import { RunnerManager } from './runner-manager';
import { RunnerDownloader } from './runner-downloader';
import { GitHubAuth } from './github-auth';
import { HeartbeatManager } from './heartbeat-manager';
import { TrayManager } from './tray';
import { Logger } from './logger';
import { CliServer } from './cli-server';
import { BrokerProxyService } from './broker-proxy-service';
import { TargetManager } from './target-manager';
import { ResourceMonitor } from './resource-monitor';
import {
  GitHubUser,
  SleepProtection,
  LogLevel,
} from '../shared/types';

// Import state machine service for runner state
import {
  sendRunnerEvent,
  getEffectivePauseState as getEffectivePauseStateFromMachine,
  isUserPaused as isUserPausedFromMachine,
  isResourcePaused as isResourcePausedFromMachine,
  getBusyInstances as getBusyInstancesFromMachine,
  selectRunnerStatus,
  getSnapshot,
} from './runner-state-service';

// Auth state structure
export interface AuthState {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  user: GitHubUser;
}

// Mutable state - module-private
let mainWindow: BrowserWindow | null = null;
let trayManager: TrayManager | null = null;
let runnerManager: RunnerManager | null = null;
let runnerDownloader: RunnerDownloader | null = null;
let githubAuth: GitHubAuth | null = null;
let heartbeatManager: HeartbeatManager | null = null;
let logger: Logger | null = null;
let cliServer: CliServer | null = null;
let brokerProxyService: BrokerProxyService | null = null;
let targetManager: TargetManager | null = null;
let resourceMonitor: ResourceMonitor | null = null;

let powerSaveBlockerId: number | null = null;
let sleepProtectionSetting: SleepProtection = 'never';
let logLevelSetting: LogLevel = 'info';
let runnerLogLevelSetting: LogLevel = 'warn';
let authState: AuthState | null = null;
let isQuitting = false;

// Track instances currently being re-registered to prevent concurrent attempts
const reregisteringInstances = new Set<number>();

// ============================================================================
// Window State
// ============================================================================

export const getMainWindow = (): BrowserWindow | null => mainWindow;
export const setMainWindow = (window: BrowserWindow | null): void => {
  mainWindow = window;
};

// ============================================================================
// Service Instances
// ============================================================================

export const getTrayManager = (): TrayManager | null => trayManager;
export const setTrayManager = (manager: TrayManager | null): void => {
  trayManager = manager;
};

export const getRunnerManager = (): RunnerManager | null => runnerManager;
export const setRunnerManager = (manager: RunnerManager | null): void => {
  runnerManager = manager;
};

export const getRunnerDownloader = (): RunnerDownloader | null => runnerDownloader;
export const setRunnerDownloader = (downloader: RunnerDownloader | null): void => {
  runnerDownloader = downloader;
};

export const getGitHubAuth = (): GitHubAuth | null => githubAuth;
export const setGitHubAuth = (auth: GitHubAuth | null): void => {
  githubAuth = auth;
};

export const getHeartbeatManager = (): HeartbeatManager | null => heartbeatManager;
export const setHeartbeatManager = (manager: HeartbeatManager | null): void => {
  heartbeatManager = manager;
};

export const getLogger = (): Logger | null => logger;
export const setLogger = (l: Logger | null): void => {
  logger = l;
};

export const getCliServer = (): CliServer | null => cliServer;
export const setCliServer = (server: CliServer | null): void => {
  cliServer = server;
};

export const getBrokerProxyService = (): BrokerProxyService | null => brokerProxyService;
export const setBrokerProxyService = (service: BrokerProxyService | null): void => {
  brokerProxyService = service;
};

export const getTargetManager = (): TargetManager | null => targetManager;
export const setTargetManager = (manager: TargetManager | null): void => {
  targetManager = manager;
};

export const getResourceMonitor = (): ResourceMonitor | null => resourceMonitor;
export const setResourceMonitor = (monitor: ResourceMonitor | null): void => {
  resourceMonitor = monitor;
};

// ============================================================================
// Resource-Aware Pause State (delegated to XState machine)
// ============================================================================

export const isResourcePaused = (): boolean => isResourcePausedFromMachine();

export const setResourcePaused = (paused: boolean, reason?: string): void => {
  if (paused) {
    sendRunnerEvent({ type: 'RESOURCE_PAUSE', reason: reason || 'Resource constraint' });
  } else {
    sendRunnerEvent({ type: 'RESOURCE_RESUME' });
  }
};

export const isUserPaused = (): boolean => isUserPausedFromMachine();

export const setUserPaused = (paused: boolean): void => {
  if (paused) {
    sendRunnerEvent({ type: 'USER_PAUSE' });
  } else {
    sendRunnerEvent({ type: 'USER_RESUME' });
  }
};

/**
 * Get the overall pause state combining user and resource pauses.
 */
export const getEffectivePauseState = (): { isPaused: boolean; reason: string | null } => {
  return getEffectivePauseStateFromMachine();
};

// ============================================================================
// Sleep Protection
// ============================================================================

export const getPowerSaveBlockerId = (): number | null => powerSaveBlockerId;
export const setPowerSaveBlockerId = (id: number | null): void => {
  powerSaveBlockerId = id;
};

export const getSleepProtectionSetting = (): SleepProtection => sleepProtectionSetting;
export const setSleepProtectionSetting = (setting: SleepProtection): void => {
  sleepProtectionSetting = setting;
};

// ============================================================================
// Log Levels
// ============================================================================

export const getLogLevelSetting = (): LogLevel => logLevelSetting;
export const setLogLevelSetting = (level: LogLevel): void => {
  logLevelSetting = level;
};

export const getRunnerLogLevelSetting = (): LogLevel => runnerLogLevelSetting;
export const setRunnerLogLevelSetting = (level: LogLevel): void => {
  runnerLogLevelSetting = level;
};

// ============================================================================
// Runner Status (delegated to XState machine)
// ============================================================================

export const getCurrentRunnerStatus = (): string => {
  const snapshot = getSnapshot();
  if (!snapshot) return 'offline';
  return selectRunnerStatus(snapshot).status;
};

// Note: setCurrentRunnerStatus is no longer used - state changes via events
// Keeping for backwards compatibility but it's a no-op
export const setCurrentRunnerStatus = (_status: string): void => {
  // Status is now managed by XState machine via events
  // This function is deprecated - use sendRunnerEvent() instead
};

// ============================================================================
// Auth State
// ============================================================================

export const getAuthState = (): AuthState | null => authState;
export const setAuthState = (state: AuthState | null): void => {
  authState = state;
};

// ============================================================================
// Quitting Flag
// ============================================================================

export const getIsQuitting = (): boolean => isQuitting;
export const setIsQuitting = (quitting: boolean): void => {
  isQuitting = quitting;
};

// ============================================================================
// Instance Tracking Sets
// ============================================================================

export const getBusyInstances = (): Set<number> => getBusyInstancesFromMachine();

export const getReregisteringInstances = (): Set<number> => reregisteringInstances;

// ============================================================================
// Convenience: Check if window is ready for IPC
// ============================================================================

export const isWindowReady = (): boolean => {
  return mainWindow !== null && !mainWindow.isDestroyed() && !isQuitting;
};

// ============================================================================
// Enable/disable sleep protection
// ============================================================================

export const enableSleepProtection = (): void => {
  if (powerSaveBlockerId !== null) return; // Already enabled

  powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  logger?.info('Sleep protection ENABLED - preventing system sleep');
};

export const disableSleepProtection = (): void => {
  if (powerSaveBlockerId === null) return; // Already disabled

  if (powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    powerSaveBlocker.stop(powerSaveBlockerId);
  }
  powerSaveBlockerId = null;
  logger?.info('Sleep protection DISABLED - system sleep allowed');
};

export const updateSleepProtection = (): void => {
  const currentStatus = getCurrentRunnerStatus();
  const shouldProtect =
    sleepProtectionSetting === 'always' ||
    (sleepProtectionSetting === 'when-busy' && currentStatus === 'busy');

  if (shouldProtect) {
    enableSleepProtection();
  } else {
    disableSleepProtection();
  }
};
