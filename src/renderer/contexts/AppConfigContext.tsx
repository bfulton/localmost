import React, { createContext, useContext, useState, useEffect, useRef, useCallback, ReactNode } from 'react';
import { LogEntry, SleepProtection, LogLevel, ToolCacheLocation, UserFilterConfig } from '../../shared/types';

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
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(true);

  // Theme
  const [theme, setThemeState] = useState<ThemeSetting>('auto');

  // Logging
  const [logLevel, setLogLevelState] = useState<LogLevel>('info');
  const [runnerLogLevel, setRunnerLogLevelState] = useState<LogLevel>('warn');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logsRef = useRef<LogEntry[]>([]);
  const [maxLogScrollback, setMaxLogScrollbackState] = useState<number>(500);
  const maxLogScrollbackRef = useRef<number>(500);

  // Job history
  const [maxJobHistory, setMaxJobHistoryState] = useState<number>(10);

  // Sleep protection
  const [sleepProtection, setSleepProtectionState] = useState<SleepProtection>('never');
  const [sleepProtectionConsented, setSleepProtectionConsentedState] = useState(false);

  // Runner settings
  const [preserveWorkDir, setPreserveWorkDirState] = useState<'never' | 'session' | 'always'>('never');
  const [toolCacheLocation, setToolCacheLocationState] = useState<ToolCacheLocation>('persistent');

  // User filter
  const [userFilter, setUserFilterState] = useState<UserFilterConfig>({ mode: 'everyone', allowlist: [] });

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

  // Initialize settings from storage
  useEffect(() => {
    const loadSettings = async () => {
      try {
        if (!window.localmost) {
          setError('Preload script not loaded. window.localmost is undefined.');
          setIsLoading(false);
          return;
        }

        const settings = await window.localmost.settings.get();

        // Theme
        if (settings.theme && typeof settings.theme === 'string' && ['light', 'dark', 'auto'].includes(settings.theme)) {
          setThemeState(settings.theme as ThemeSetting);
        }

        // Log scrollback
        const savedMaxScrollback = settings.maxLogScrollback ? Number(settings.maxLogScrollback) : 500;
        if (savedMaxScrollback > 0) {
          setMaxLogScrollbackState(savedMaxScrollback);
          maxLogScrollbackRef.current = savedMaxScrollback;
        }

        // Job history
        const savedMaxJobHistory = settings.maxJobHistory ? Number(settings.maxJobHistory) : 10;
        if (savedMaxJobHistory >= 5 && savedMaxJobHistory <= 50) {
          setMaxJobHistoryState(savedMaxJobHistory);
        }

        // Sleep protection
        if (settings.sleepProtection && ['never', 'when-busy', 'always'].includes(settings.sleepProtection as string)) {
          setSleepProtectionState(settings.sleepProtection as SleepProtection);
        }
        if (settings.sleepProtectionConsented) {
          setSleepProtectionConsentedState(true);
        }

        // Preserve work dir
        if (settings.preserveWorkDir && ['never', 'session', 'always'].includes(settings.preserveWorkDir as string)) {
          setPreserveWorkDirState(settings.preserveWorkDir as 'never' | 'session' | 'always');
        }

        // Tool cache location
        if (settings.toolCacheLocation && ['persistent', 'per-sandbox'].includes(settings.toolCacheLocation as string)) {
          setToolCacheLocationState(settings.toolCacheLocation as ToolCacheLocation);
        }

        // Log levels
        if (settings.logLevel && ['debug', 'info', 'warn', 'error'].includes(settings.logLevel as string)) {
          setLogLevelState(settings.logLevel as LogLevel);
        }
        if (settings.runnerLogLevel && ['debug', 'info', 'warn', 'error'].includes(settings.runnerLogLevel as string)) {
          setRunnerLogLevelState(settings.runnerLogLevel as LogLevel);
        }

        // User filter
        if (settings.userFilter) {
          const filter = settings.userFilter as UserFilterConfig;
          if (filter.mode && ['everyone', 'just-me', 'allowlist'].includes(filter.mode)) {
            setUserFilterState({
              mode: filter.mode,
              allowlist: Array.isArray(filter.allowlist) ? filter.allowlist : [],
            });
          }
        }

        setIsLoading(false);
      } catch (err) {
        setError(`Failed to load settings: ${(err as Error).message}`);
        setIsLoading(false);
      }
    };

    loadSettings();

    // Subscribe to logs
    const unsubLogs = window.localmost.logs.onEntry((entry: LogEntry) => {
      const max = maxLogScrollbackRef.current;
      logsRef.current = [...logsRef.current.slice(-(max - 1)), entry];
      setLogs(logsRef.current);
    });

    // Network status
    window.localmost.network.isOnline().then(setIsOnline);
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      unsubLogs();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Setting updaters with persistence
  const setTheme = useCallback(async (newTheme: ThemeSetting) => {
    setThemeState(newTheme);
    await window.localmost.settings.set({ theme: newTheme });
  }, []);

  const setLogLevel = useCallback(async (newLevel: LogLevel) => {
    setLogLevelState(newLevel);
    await window.localmost.settings.set({ logLevel: newLevel });
  }, []);

  const setRunnerLogLevel = useCallback(async (newLevel: LogLevel) => {
    setRunnerLogLevelState(newLevel);
    await window.localmost.settings.set({ runnerLogLevel: newLevel });
  }, []);

  const setMaxLogScrollback = useCallback(async (newMax: number) => {
    setMaxLogScrollbackState(newMax);
    maxLogScrollbackRef.current = newMax;
    await window.localmost.settings.set({ maxLogScrollback: newMax });
    // Trim existing logs if needed
    if (logsRef.current.length > newMax) {
      logsRef.current = logsRef.current.slice(-newMax);
      setLogs(logsRef.current);
    }
  }, []);

  const setMaxJobHistory = useCallback(async (newMax: number) => {
    setMaxJobHistoryState(newMax);
    await window.localmost.settings.set({ maxJobHistory: newMax });
    await window.localmost.jobs.setMaxHistory(newMax);
  }, []);

  const setSleepProtection = useCallback(async (newSetting: SleepProtection) => {
    setSleepProtectionState(newSetting);
    await window.localmost.settings.set({ sleepProtection: newSetting });
  }, []);

  const consentToSleepProtection = useCallback(async () => {
    setSleepProtectionConsentedState(true);
    await window.localmost.settings.set({ sleepProtectionConsented: true });
  }, []);

  const setPreserveWorkDir = useCallback(async (setting: 'never' | 'session' | 'always') => {
    setPreserveWorkDirState(setting);
    await window.localmost.settings.set({ preserveWorkDir: setting });
  }, []);

  const setToolCacheLocation = useCallback(async (setting: ToolCacheLocation) => {
    setToolCacheLocationState(setting);
    await window.localmost.settings.set({ toolCacheLocation: setting });
  }, []);

  const setUserFilter = useCallback(async (filter: UserFilterConfig) => {
    setUserFilterState(filter);
    await window.localmost.settings.set({ userFilter: filter });
  }, []);

  const clearLogs = useCallback(() => {
    logsRef.current = [];
    setLogs([]);
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
    setMaxLogScrollback,
    maxJobHistory,
    setMaxJobHistory,
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
