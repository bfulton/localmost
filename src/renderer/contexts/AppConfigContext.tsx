/**
 * AppConfigContext - provides app configuration state to React components.
 *
 * This context now reads state from the Zustand store (synced from main via zubridge)
 * and updates via IPC calls (which update the main store and persist to disk).
 */

import React, { createContext, useContext, useEffect, useRef, useCallback, useState, ReactNode } from 'react';
import {
  LogEntry,
  SleepProtection,
  LogLevel,
  ToolCacheLocation,
  UserFilterConfig,
  PowerConfig,
  BatteryPauseThreshold,
  NotificationsConfig,
  DEFAULT_POWER_CONFIG,
  DEFAULT_NOTIFICATIONS_CONFIG,
} from '../../shared/types';
import {
  useStore,
} from '../store';

export type ThemeSetting = 'light' | 'dark' | 'auto';

interface AppConfigContextValue {
  // Theme
  theme: ThemeSetting;
  setTheme: (theme: ThemeSetting) => Promise<void>;

  // Logging
  logLevel: LogLevel;
  setLogLevel: (level: LogLevel) => Promise<void>;
  runnerLogLevel: LogLevel;
  setRunnerLogLevel: (level: LogLevel) => Promise<void>;
  logs: LogEntry[];
  clearLogs: () => void;
  maxLogScrollback: number;
  setMaxLogScrollback: (max: number) => Promise<void>;

  // Job history
  maxJobHistory: number;
  setMaxJobHistory: (max: number) => Promise<void>;

  // Sleep protection
  sleepProtection: SleepProtection;
  setSleepProtection: (setting: SleepProtection) => Promise<void>;
  sleepProtectionConsented: boolean;
  consentToSleepProtection: () => Promise<void>;

  // Runner settings
  preserveWorkDir: 'never' | 'session' | 'always';
  setPreserveWorkDir: (setting: 'never' | 'session' | 'always') => Promise<void>;
  toolCacheLocation: ToolCacheLocation;
  setToolCacheLocation: (setting: ToolCacheLocation) => Promise<void>;

  // User filter
  userFilter: UserFilterConfig;
  setUserFilter: (filter: UserFilterConfig) => Promise<void>;

  // Power settings
  power: PowerConfig;
  setPower: (config: PowerConfig) => Promise<void>;
  setPauseOnBattery: (threshold: BatteryPauseThreshold) => Promise<void>;
  setPauseOnVideoCall: (enabled: boolean) => Promise<void>;

  // Notifications
  notifications: NotificationsConfig;
  setNotifications: (config: NotificationsConfig) => Promise<void>;
  setNotifyOnPause: (enabled: boolean) => Promise<void>;
  setNotifyOnJobEvents: (enabled: boolean) => Promise<void>;

  // App state
  isOnline: boolean;
  isLoading: boolean;
  error: string | null;
}

const AppConfigContext = createContext<AppConfigContextValue | null>(null);

const getSystemTheme = (): 'light' | 'dark' => {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const applyTheme = (theme: ThemeSetting) => {
  const effectiveTheme = theme === 'auto' ? getSystemTheme() : theme;
  document.documentElement.setAttribute('data-theme', effectiveTheme);
};

interface AppConfigProviderProps {
  children: ReactNode;
}

export const AppConfigProvider: React.FC<AppConfigProviderProps> = ({ children }) => {
  // Read state from Zustand store (synced from main via zubridge)
  // Use optional chaining since store may not be initialized yet
  const storeTheme = useStore((state) => state?.config?.theme ?? 'auto');
  const storeLogLevel = useStore((state) => state?.config?.logLevel ?? 'info');
  const storeRunnerLogLevel = useStore((state) => state?.config?.runnerLogLevel ?? 'warn');
  const storeMaxLogScrollback = useStore((state) => state?.config?.maxLogScrollback ?? 500);
  const storeMaxJobHistory = useStore((state) => state?.config?.maxJobHistory ?? 10);
  const storeSleepProtection = useStore((state) => state?.config?.sleepProtection ?? 'never');
  const storeSleepProtectionConsented = useStore((state) => state?.config?.sleepProtectionConsented ?? false);
  const storePreserveWorkDir = useStore((state) => state?.config?.preserveWorkDir ?? 'never');
  const storeToolCacheLocation = useStore((state) => state?.config?.toolCacheLocation ?? 'persistent');
  const storeUserFilter = useStore((state) => state?.config?.userFilter ?? { mode: 'just-me' as const, allowlist: [] });
  const storePower = useStore((state) => state?.config?.power ?? DEFAULT_POWER_CONFIG);
  const storeNotifications = useStore((state) => state?.config?.notifications ?? DEFAULT_NOTIFICATIONS_CONFIG);
  const storeIsOnline = useStore((state) => state?.ui?.isOnline ?? true);
  const storeIsLoading = useStore((state) => state?.ui?.isInitialLoading ?? true);
  const storeError = useStore((state) => state?.ui?.error ?? null);

  // Local state for logs (handled via IPC subscription for real-time updates)
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logsRef = useRef<LogEntry[]>([]);
  const maxLogScrollbackRef = useRef<number>(storeMaxLogScrollback);

  // Check if zubridge has synced state from main
  // useStore() without selector returns the full state - null if not yet synced
  const storeState = useStore();
  const isZubridgeReady = storeState !== null && storeState !== undefined;

  // Fallback state for when zubridge isn't ready yet
  const [fallbackState, setFallbackState] = useState<{
    theme: ThemeSetting;
    logLevel: LogLevel;
    runnerLogLevel: LogLevel;
    maxLogScrollback: number;
    maxJobHistory: number;
    sleepProtection: SleepProtection;
    sleepProtectionConsented: boolean;
    preserveWorkDir: 'never' | 'session' | 'always';
    toolCacheLocation: ToolCacheLocation;
    userFilter: UserFilterConfig;
    power: PowerConfig;
    notifications: NotificationsConfig;
    isOnline: boolean;
    isLoading: boolean;
    error: string | null;
  }>({
    theme: 'auto',
    logLevel: 'info',
    runnerLogLevel: 'warn',
    maxLogScrollback: 500,
    maxJobHistory: 10,
    sleepProtection: 'never',
    sleepProtectionConsented: false,
    preserveWorkDir: 'never',
    toolCacheLocation: 'persistent',
    userFilter: { scope: 'everyone', allowedUsers: 'just-me', allowlist: [] },
    power: DEFAULT_POWER_CONFIG,
    notifications: DEFAULT_NOTIFICATIONS_CONFIG,
    isOnline: true,
    isLoading: true,
    error: null,
  });

  // Use store values if zubridge is ready, otherwise use fallback
  const theme = isZubridgeReady ? storeTheme : fallbackState.theme;
  const logLevel = isZubridgeReady ? storeLogLevel : fallbackState.logLevel;
  const runnerLogLevel = isZubridgeReady ? storeRunnerLogLevel : fallbackState.runnerLogLevel;
  const maxLogScrollback = isZubridgeReady ? storeMaxLogScrollback : fallbackState.maxLogScrollback;
  const maxJobHistory = isZubridgeReady ? storeMaxJobHistory : fallbackState.maxJobHistory;
  const sleepProtection = isZubridgeReady ? storeSleepProtection : fallbackState.sleepProtection;
  const sleepProtectionConsented = isZubridgeReady ? storeSleepProtectionConsented : fallbackState.sleepProtectionConsented;
  const preserveWorkDir = isZubridgeReady ? storePreserveWorkDir : fallbackState.preserveWorkDir;
  const toolCacheLocation = isZubridgeReady ? storeToolCacheLocation : fallbackState.toolCacheLocation;
  const userFilter = isZubridgeReady ? storeUserFilter : fallbackState.userFilter;
  const power = isZubridgeReady ? storePower : fallbackState.power;
  const notifications = isZubridgeReady ? storeNotifications : fallbackState.notifications;
  const isOnline = isZubridgeReady ? storeIsOnline : fallbackState.isOnline;
  const isLoading = isZubridgeReady ? storeIsLoading : fallbackState.isLoading;
  const error = isZubridgeReady ? storeError : fallbackState.error;

  // Keep ref in sync with store value
  useEffect(() => {
    maxLogScrollbackRef.current = maxLogScrollback;
  }, [maxLogScrollback]);

  // Apply theme whenever it changes
  useEffect(() => {
    applyTheme(theme);

    if (theme === 'auto') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = () => applyTheme('auto');
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
  }, [theme]);

  // Initialize: load settings and subscribe to logs
  useEffect(() => {
    const init = async () => {
      if (!window.localmost) {
        setFallbackState(prev => ({
          ...prev,
          error: 'Preload script not loaded. window.localmost is undefined.',
          isLoading: false,
        }));
        return;
      }

      // Load settings via IPC (fallback until zubridge syncs)
      try {
        const settings = await window.localmost.settings.get();

        setFallbackState(prev => ({
          ...prev,
          theme: (settings.theme as ThemeSetting) || prev.theme,
          logLevel: (settings.logLevel as LogLevel) || prev.logLevel,
          runnerLogLevel: (settings.runnerLogLevel as LogLevel) || prev.runnerLogLevel,
          maxLogScrollback: settings.maxLogScrollback ? Number(settings.maxLogScrollback) : prev.maxLogScrollback,
          maxJobHistory: settings.maxJobHistory ? Number(settings.maxJobHistory) : prev.maxJobHistory,
          sleepProtection: (settings.sleepProtection as SleepProtection) || prev.sleepProtection,
          sleepProtectionConsented: settings.sleepProtectionConsented || prev.sleepProtectionConsented,
          preserveWorkDir: (settings.preserveWorkDir as 'never' | 'session' | 'always') || prev.preserveWorkDir,
          toolCacheLocation: (settings.toolCacheLocation as ToolCacheLocation) || prev.toolCacheLocation,
          userFilter: settings.userFilter && ['everyone', 'trigger', 'contributors'].includes((settings.userFilter as UserFilterConfig).scope)
            ? (settings.userFilter as UserFilterConfig)
            : prev.userFilter,
          power: settings.power ? { ...DEFAULT_POWER_CONFIG, ...(settings.power as PowerConfig) } : prev.power,
          notifications: settings.notifications ? { ...DEFAULT_NOTIFICATIONS_CONFIG, ...(settings.notifications as NotificationsConfig) } : prev.notifications,
          isLoading: false,
        }));

        // zubridge readiness is now detected automatically via useStore() return value
      } catch (err) {
        setFallbackState(prev => ({
          ...prev,
          error: `Failed to load settings: ${(err as Error).message}`,
          isLoading: false,
        }));
      }
    };

    init();

    // Subscribe to logs
    const unsubLogs = window.localmost?.logs?.onEntry((entry: LogEntry) => {
      const max = maxLogScrollbackRef.current;
      logsRef.current = [...logsRef.current.slice(-(max - 1)), entry];
      setLogs(logsRef.current);
    });

    // Network status
    window.localmost?.network?.isOnline().then((online: boolean) => {
      setFallbackState(prev => ({ ...prev, isOnline: online }));
    }).catch(() => {
      // Default to online if check fails
    });
    const handleOnline = () => setFallbackState(prev => ({ ...prev, isOnline: true }));
    const handleOffline = () => setFallbackState(prev => ({ ...prev, isOnline: false }));
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      unsubLogs?.();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Setting updaters - call IPC which updates main store + persists
  const setTheme = useCallback(async (newTheme: ThemeSetting) => {
    // Optimistic update for fallback state
    setFallbackState(prev => ({ ...prev, theme: newTheme }));
    try {
      await window.localmost.settings.set({ theme: newTheme });
    } catch {
      // Store update failed, but zubridge will sync if main store was updated
    }
  }, []);

  const setLogLevel = useCallback(async (newLevel: LogLevel) => {
    setFallbackState(prev => ({ ...prev, logLevel: newLevel }));
    try {
      await window.localmost.settings.set({ logLevel: newLevel });
    } catch {
      // Optimistic update handled by zubridge sync
    }
  }, []);

  const setRunnerLogLevel = useCallback(async (newLevel: LogLevel) => {
    setFallbackState(prev => ({ ...prev, runnerLogLevel: newLevel }));
    try {
      await window.localmost.settings.set({ runnerLogLevel: newLevel });
    } catch {
      // Optimistic update handled by zubridge sync
    }
  }, []);

  const setMaxLogScrollback = useCallback(async (newMax: number) => {
    maxLogScrollbackRef.current = newMax;
    setFallbackState(prev => ({ ...prev, maxLogScrollback: newMax }));
    try {
      await window.localmost.settings.set({ maxLogScrollback: newMax });
    } catch {
      // Optimistic update handled by zubridge sync
    }
    // Trim existing logs if needed
    if (logsRef.current.length > newMax) {
      logsRef.current = logsRef.current.slice(-newMax);
      setLogs(logsRef.current);
    }
  }, []);

  const setMaxJobHistory = useCallback(async (newMax: number) => {
    setFallbackState(prev => ({ ...prev, maxJobHistory: newMax }));
    try {
      await window.localmost.settings.set({ maxJobHistory: newMax });
      await window.localmost.jobs.setMaxHistory(newMax);
    } catch {
      // Optimistic update handled by zubridge sync
    }
  }, []);

  const setSleepProtection = useCallback(async (newSetting: SleepProtection) => {
    setFallbackState(prev => ({ ...prev, sleepProtection: newSetting }));
    try {
      await window.localmost.settings.set({ sleepProtection: newSetting });
    } catch {
      // Optimistic update handled by zubridge sync
    }
  }, []);

  const consentToSleepProtection = useCallback(async () => {
    setFallbackState(prev => ({ ...prev, sleepProtectionConsented: true }));
    try {
      await window.localmost.settings.set({ sleepProtectionConsented: true });
    } catch {
      // Optimistic update handled by zubridge sync
    }
  }, []);

  const setPreserveWorkDir = useCallback(async (setting: 'never' | 'session' | 'always') => {
    setFallbackState(prev => ({ ...prev, preserveWorkDir: setting }));
    try {
      await window.localmost.settings.set({ preserveWorkDir: setting });
    } catch {
      // Optimistic update handled by zubridge sync
    }
  }, []);

  const setToolCacheLocation = useCallback(async (setting: ToolCacheLocation) => {
    setFallbackState(prev => ({ ...prev, toolCacheLocation: setting }));
    try {
      await window.localmost.settings.set({ toolCacheLocation: setting });
    } catch {
      // Optimistic update handled by zubridge sync
    }
  }, []);

  const setUserFilter = useCallback(async (filter: UserFilterConfig) => {
    setFallbackState(prev => ({ ...prev, userFilter: filter }));
    try {
      await window.localmost.settings.set({ userFilter: filter });
    } catch {
      // Optimistic update handled by zubridge sync
    }
  }, []);

  const setPower = useCallback(async (config: PowerConfig) => {
    setFallbackState(prev => ({ ...prev, power: config }));
    try {
      await window.localmost.settings.set({ power: config });
    } catch {
      // Optimistic update handled by zubridge sync
    }
  }, []);

  const setPauseOnBattery = useCallback(async (threshold: BatteryPauseThreshold) => {
    const newConfig = { ...power, pauseOnBattery: threshold };
    setFallbackState(prev => ({ ...prev, power: newConfig }));
    try {
      await window.localmost.settings.set({ power: newConfig });
    } catch {
      // Optimistic update handled by zubridge sync
    }
  }, [power]);

  const setPauseOnVideoCall = useCallback(async (enabled: boolean) => {
    const newConfig = { ...power, pauseOnVideoCall: enabled };
    setFallbackState(prev => ({ ...prev, power: newConfig }));
    try {
      await window.localmost.settings.set({ power: newConfig });
    } catch {
      // Optimistic update handled by zubridge sync
    }
  }, [power]);

  const setNotifications = useCallback(async (config: NotificationsConfig) => {
    setFallbackState(prev => ({ ...prev, notifications: config }));
    try {
      await window.localmost.settings.set({ notifications: config });
    } catch {
      // Optimistic update handled by zubridge sync
    }
  }, []);

  const setNotifyOnPause = useCallback(async (enabled: boolean) => {
    const newConfig = { ...notifications, notifyOnPause: enabled };
    setFallbackState(prev => ({ ...prev, notifications: newConfig }));
    try {
      await window.localmost.settings.set({ notifications: newConfig });
    } catch {
      // Optimistic update handled by zubridge sync
    }
  }, [notifications]);

  const setNotifyOnJobEvents = useCallback(async (enabled: boolean) => {
    const newConfig = { ...notifications, notifyOnJobEvents: enabled };
    setFallbackState(prev => ({ ...prev, notifications: newConfig }));
    try {
      await window.localmost.settings.set({ notifications: newConfig });
    } catch {
      // Optimistic update handled by zubridge sync
    }
  }, [notifications]);

  const clearLogs = useCallback(() => {
    logsRef.current = [];
    setLogs([]);
    window.localmost?.logs?.clear();
  }, []);

  const value: AppConfigContextValue = {
    theme,
    setTheme,
    logLevel,
    setLogLevel,
    runnerLogLevel,
    setRunnerLogLevel,
    logs,
    clearLogs,
    maxLogScrollback,
    setMaxJobHistory,
    maxJobHistory,
    setMaxLogScrollback,
    sleepProtection,
    setSleepProtection,
    sleepProtectionConsented,
    consentToSleepProtection,
    preserveWorkDir,
    setPreserveWorkDir,
    toolCacheLocation,
    setToolCacheLocation,
    userFilter,
    setUserFilter,
    power,
    setPower,
    setPauseOnBattery,
    setPauseOnVideoCall,
    notifications,
    setNotifications,
    setNotifyOnPause,
    setNotifyOnJobEvents,
    isOnline,
    isLoading,
    error,
  };

  return (
    <AppConfigContext.Provider value={value}>
      {children}
    </AppConfigContext.Provider>
  );
};

export const useAppConfig = (): AppConfigContextValue => {
  const context = useContext(AppConfigContext);
  if (!context) {
    throw new Error('useAppConfig must be used within an AppConfigProvider');
  }
  return context;
};
