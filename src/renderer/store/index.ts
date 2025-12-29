/**
 * Renderer-side Zustand store hook.
 *
 * This hook provides access to the synchronized store from the main process.
 * State is automatically synced via zubridge IPC.
 */

import { createUseStore, useDispatch as useZubridgeDispatch } from '@zubridge/electron';
import type { AppState, AppStore } from '../../main/store/types';

// Create the store hook - this connects to the main process store via zubridge
export const useStore = createUseStore<AppState>();

// Re-export dispatch hook with proper typing
export const useDispatch = () => useZubridgeDispatch<AppState>();

// =============================================================================
// Convenience hooks for common state slices
// =============================================================================

// Config hooks
export const useTheme = () => useStore((state) => state.config.theme);
export const useLogLevel = () => useStore((state) => state.config.logLevel);
export const useRunnerLogLevel = () => useStore((state) => state.config.runnerLogLevel);
export const useMaxLogScrollback = () => useStore((state) => state.config.maxLogScrollback);
export const useMaxJobHistory = () => useStore((state) => state.config.maxJobHistory);
export const useSleepProtection = () => useStore((state) => state.config.sleepProtection);
export const useSleepProtectionConsented = () => useStore((state) => state.config.sleepProtectionConsented);
export const usePreserveWorkDir = () => useStore((state) => state.config.preserveWorkDir);
export const useToolCacheLocation = () => useStore((state) => state.config.toolCacheLocation);
export const useUserFilter = () => useStore((state) => state.config.userFilter);
export const usePower = () => useStore((state) => state.config.power);
export const useNotifications = () => useStore((state) => state.config.notifications);
export const useLaunchAtLogin = () => useStore((state) => state.config.launchAtLogin);
export const useHideOnStart = () => useStore((state) => state.config.hideOnStart);
export const useRunnerConfig = () => useStore((state) => state.config.runnerConfig);
export const useTargets = () => useStore((state) => state.config.targets);

// Auth hooks
export const useUser = () => useStore((state) => state.auth.user);
export const useIsAuthenticated = () => useStore((state) => state.auth.isAuthenticated);
export const useIsAuthenticating = () => useStore((state) => state.auth.isAuthenticating);
export const useDeviceCode = () => useStore((state) => state.auth.deviceCode);

// Runner hooks
export const useRunnerState = () => useStore((state) => state.runner.runnerState);
export const useIsDownloaded = () => useStore((state) => state.runner.isDownloaded);
export const useIsConfigured = () => useStore((state) => state.runner.isConfigured);
export const useRunnerVersion = () => useStore((state) => state.runner.runnerVersion);
export const useAvailableVersions = () => useStore((state) => state.runner.availableVersions);
export const useSelectedVersion = () => useStore((state) => state.runner.selectedVersion);
export const useDownloadProgress = () => useStore((state) => state.runner.downloadProgress);
export const useIsLoadingVersions = () => useStore((state) => state.runner.isLoadingVersions);
export const useRunnerDisplayName = () => useStore((state) => state.runner.runnerDisplayName);
export const useTargetStatus = () => useStore((state) => state.runner.targetStatus);

// Jobs hooks
export const useJobHistory = () => useStore((state) => state.jobs.history);

// GitHub hooks
export const useRepos = () => useStore((state) => state.github.repos);
export const useOrgs = () => useStore((state) => state.github.orgs);

// Update hooks
export const useUpdateStatus = () => useStore((state) => state.update.status);
export const useUpdateSettings = () => useStore((state) => state.update.settings);
export const useIsUpdateChecking = () => useStore((state) => state.update.isChecking);
export const useIsUpdateDismissed = () => useStore((state) => state.update.isDismissed);

// UI hooks
export const useIsOnline = () => useStore((state) => state.ui.isOnline);
export const useIsLoading = () => useStore((state) => state.ui.isLoading);
export const useIsInitialLoading = () => useStore((state) => state.ui.isInitialLoading);
export const useError = () => useStore((state) => state.ui.error);
export const useLogs = () => useStore((state) => state.ui.logs);

// =============================================================================
// Action dispatchers
// =============================================================================

/**
 * Dispatch action types for the store.
 * These match the action names in the main process store.
 */
export type StoreAction =
  // Config actions
  | { type: 'setTheme'; payload: AppState['config']['theme'] }
  | { type: 'setLogLevel'; payload: AppState['config']['logLevel'] }
  | { type: 'setRunnerLogLevel'; payload: AppState['config']['runnerLogLevel'] }
  | { type: 'setMaxLogScrollback'; payload: number }
  | { type: 'setMaxJobHistory'; payload: number }
  | { type: 'setSleepProtection'; payload: AppState['config']['sleepProtection'] }
  | { type: 'consentToSleepProtection' }
  | { type: 'setPreserveWorkDir'; payload: AppState['config']['preserveWorkDir'] }
  | { type: 'setToolCacheLocation'; payload: AppState['config']['toolCacheLocation'] }
  | { type: 'setUserFilter'; payload: AppState['config']['userFilter'] }
  | { type: 'setPower'; payload: AppState['config']['power'] }
  | { type: 'setNotifications'; payload: AppState['config']['notifications'] }
  | { type: 'setLaunchAtLogin'; payload: boolean }
  | { type: 'setHideOnStart'; payload: boolean }
  | { type: 'updateRunnerConfig'; payload: Partial<AppState['config']['runnerConfig']> }
  | { type: 'setTargets'; payload: AppState['config']['targets'] }
  // UI actions
  | { type: 'setError'; payload: string | null }
  | { type: 'clearLogs' }
  | { type: 'setIsDismissed'; payload: boolean };
