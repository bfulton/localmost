import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { UpdateStatus, UpdateSettings } from '../../shared/types';

interface UpdateContextValue {
  // Current update state
  status: UpdateStatus;

  // Settings
  settings: UpdateSettings;
  setSettings: (settings: UpdateSettings) => Promise<void>;

  // Actions
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  dismissUpdate: () => void;

  // UI state
  isChecking: boolean;
  isDismissed: boolean;
  lastChecked: Date | null;
}

const defaultStatus: UpdateStatus = {
  status: 'idle',
  currentVersion: '',
};

const defaultSettings: UpdateSettings = {
  autoCheck: true,
  checkIntervalHours: 24,
};

const UpdateContext = createContext<UpdateContextValue | null>(null);

interface UpdateProviderProps {
  children: ReactNode;
}

export const UpdateProvider: React.FC<UpdateProviderProps> = ({ children }) => {
  const [status, setStatus] = useState<UpdateStatus>(defaultStatus);
  const [settings, setSettingsState] = useState<UpdateSettings>(defaultSettings);
  const [isChecking, setIsChecking] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  // Load initial status and settings
  useEffect(() => {
    const init = async () => {
      if (!window.localmost?.update) return;

      // Get current status
      try {
        const currentStatus = await window.localmost.update.getStatus();
        setStatus(currentStatus);
      } catch {
        // Ignore errors on initial load
      }

      // Load settings
      try {
        const savedSettings = await window.localmost.settings.get();
        if (savedSettings.updateSettings) {
          const updateSettings = savedSettings.updateSettings as UpdateSettings;
          setSettingsState({
            autoCheck: updateSettings.autoCheck ?? true,
            checkIntervalHours: updateSettings.checkIntervalHours ?? 24,
          });
        }
      } catch {
        // Use defaults
      }
    };

    init();

    // Subscribe to status updates
    const unsubscribe = window.localmost?.update?.onStatusChange((newStatus: UpdateStatus) => {
      setStatus(newStatus);
      setIsChecking(newStatus.status === 'checking');
      // Reset dismissed state when new update is available
      if (newStatus.status === 'available') {
        setIsDismissed(false);
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  const checkForUpdates = useCallback(async () => {
    if (!window.localmost?.update) return;
    setIsChecking(true);
    setIsDismissed(false);
    try {
      await window.localmost.update.check();
      setLastChecked(new Date());
    } catch {
      // Error handling is done via status updates
    } finally {
      setIsChecking(false);
    }
  }, []);

  const downloadUpdate = useCallback(async () => {
    if (!window.localmost?.update) return;
    await window.localmost.update.download();
  }, []);

  const installUpdate = useCallback(async () => {
    if (!window.localmost?.update) return;
    await window.localmost.update.install();
  }, []);

  const dismissUpdate = useCallback(() => {
    setIsDismissed(true);
  }, []);

  const setSettings = useCallback(async (newSettings: UpdateSettings) => {
    setSettingsState(newSettings);
    try {
      await window.localmost.settings.set({ updateSettings: newSettings });
    } catch {
      // Optimistic update - UI already changed
    }
  }, []);

  const value: UpdateContextValue = {
    status,
    settings,
    setSettings,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    dismissUpdate,
    isChecking,
    isDismissed,
    lastChecked,
  };

  return (
    <UpdateContext.Provider value={value}>
      {children}
    </UpdateContext.Provider>
  );
};

export const useUpdate = (): UpdateContextValue => {
  const context = useContext(UpdateContext);
  if (!context) {
    throw new Error('useUpdate must be used within an UpdateProvider');
  }
  return context;
};
