/**
 * UpdateContext - provides update state to React components.
 *
 * This context now reads state from the Zustand store (synced from main via zubridge)
 * and updates via IPC calls (which update the main store).
 */

import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { UpdateStatus, UpdateSettings } from '../../shared/types';
import { useStore } from '../store';

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
  // Check if zubridge has synced state from main
  const storeState = useStore();
  const isZubridgeReady = storeState !== null && storeState !== undefined;

  // Read state from Zustand store when ready
  const storeStatus = useStore((state) => state?.update?.status ?? defaultStatus);
  const storeSettings = useStore((state) => state?.update?.settings ?? defaultSettings);
  const storeIsChecking = useStore((state) => state?.update?.isChecking ?? false);
  const storeIsDismissed = useStore((state) => state?.update?.isDismissed ?? false);
  const storeLastChecked = useStore((state) => state?.update?.lastChecked ?? null);

  // Fallback state for when zubridge isn't ready
  const [fallbackState, setFallbackState] = useState({
    status: defaultStatus,
    settings: defaultSettings,
    isChecking: false,
    isDismissed: false,
    lastChecked: null as string | null,
  });

  // Use store values if ready, otherwise fallback
  const status = isZubridgeReady ? storeStatus : fallbackState.status;
  const settings = isZubridgeReady ? storeSettings : fallbackState.settings;
  const isChecking = isZubridgeReady ? storeIsChecking : fallbackState.isChecking;
  const isDismissed = isZubridgeReady ? storeIsDismissed : fallbackState.isDismissed;
  const lastCheckedStr = isZubridgeReady ? storeLastChecked : fallbackState.lastChecked;
  const lastChecked = lastCheckedStr ? new Date(lastCheckedStr) : null;

  // Load initial status and settings via IPC (fallback until zubridge syncs)
  useEffect(() => {
    const init = async () => {
      if (!window.localmost?.update) return;

      // Get current status
      try {
        const currentStatus = await window.localmost.update.getStatus();
        setFallbackState(prev => ({ ...prev, status: currentStatus }));
      } catch {
        // Ignore errors on initial load
      }

      // Load settings
      try {
        const savedSettings = await window.localmost.settings.get();
        if (savedSettings.updateSettings) {
          const updateSettings = savedSettings.updateSettings as UpdateSettings;
          setFallbackState(prev => ({
            ...prev,
            settings: {
              autoCheck: updateSettings.autoCheck ?? true,
              checkIntervalHours: updateSettings.checkIntervalHours ?? 24,
            },
          }));
        }
      } catch {
        // Use defaults
      }
    };

    init();

    // Subscribe to status updates
    const unsubscribe = window.localmost?.update?.onStatusChange((newStatus: UpdateStatus) => {
      setFallbackState(prev => ({
        ...prev,
        status: newStatus,
        isChecking: newStatus.status === 'checking',
        // Reset dismissed state when new update is available
        isDismissed: newStatus.status === 'available' ? false : prev.isDismissed,
      }));
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  const checkForUpdates = useCallback(async () => {
    if (!window.localmost?.update) return;
    setFallbackState(prev => ({ ...prev, isChecking: true, isDismissed: false }));
    try {
      await window.localmost.update.check();
      const now = new Date().toISOString();
      setFallbackState(prev => ({ ...prev, lastChecked: now }));
      // Clear "Up to date" message after 5 seconds
      setTimeout(() => setFallbackState(prev => ({ ...prev, lastChecked: null })), 5000);
    } catch {
      // Error handling is done via status updates
    } finally {
      setFallbackState(prev => ({ ...prev, isChecking: false }));
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
    setFallbackState(prev => ({ ...prev, isDismissed: true }));
  }, []);

  const setSettingsCallback = useCallback(async (newSettings: UpdateSettings) => {
    setFallbackState(prev => ({ ...prev, settings: newSettings }));
    try {
      await window.localmost.settings.set({ updateSettings: newSettings });
    } catch {
      // Optimistic update - UI already changed
    }
  }, []);

  const value: UpdateContextValue = {
    status,
    settings,
    setSettings: setSettingsCallback,
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
