/**
 * Tray initialization and update helpers.
 */

import { app } from 'electron';
import { TrayManager, TrayStatusInfo } from './tray';
import {
  getMainWindow,
  getTrayManager,
  setTrayManager,
  getRunnerManager,
  getAuthState,
  getPowerSaveBlockerId,
  getBrokerProxyService,
  getEffectivePauseState,
  setUserPaused,
  setResourcePaused,
  getLogger,
  getHeartbeatManager,
  getIsQuitting,
} from './app-state';
import { IPC_CHANNELS } from '../shared/types';
import { findAsset } from './log-file';
import { confirmQuitIfBusy } from './window';

/**
 * Initialize the system tray using TrayManager.
 */
export const initTray = (): void => {
  const trayManager = new TrayManager(
    {
      onShowStatus: () => {
        const mainWindow = getMainWindow();
        mainWindow?.show();
        mainWindow?.webContents.send('navigate', 'status');
        mainWindow?.focus();
      },
      onShowSettings: () => {
        const mainWindow = getMainWindow();
        mainWindow?.show();
        mainWindow?.webContents.send('navigate', 'settings');
        mainWindow?.focus();
      },
      onShowWindow: () => {
        getLogger()?.info('Showing window');
        const mainWindow = getMainWindow();
        mainWindow?.show();
        mainWindow?.focus();
        updateTrayMenu();
      },
      onHideWindow: () => {
        getLogger()?.info('Hiding window');
        const mainWindow = getMainWindow();
        mainWindow?.hide();
        // Ensure dock icon stays visible on macOS
        if (process.platform === 'darwin' && app.dock) {
          app.dock.show();
        }
        updateTrayMenu();
      },
      onPause: async () => {
        getLogger()?.info('User paused runner');
        setUserPaused(true);

        // Stop heartbeat timer first, then clear variables
        const heartbeatManager = getHeartbeatManager();
        heartbeatManager?.stop();
        await heartbeatManager?.clear();

        // Notify renderer of pause state change
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed() && !getIsQuitting()) {
          mainWindow.webContents.send(IPC_CHANNELS.RESOURCE_STATE_CHANGED, {
            isPaused: true,
            reason: 'Paused by user',
            conditions: [],
          });
        }

        updateTrayMenu();
      },
      onResume: async () => {
        getLogger()?.info('User resumed runner');
        // Clear both user and resource pause - user override takes precedence
        setUserPaused(false);
        setResourcePaused(false);

        // Restart heartbeat to signal availability
        const heartbeatManager = getHeartbeatManager();
        const authState = getAuthState();
        if (heartbeatManager && authState?.accessToken) {
          await heartbeatManager.start();
        }

        // Notify renderer of pause state change
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed() && !getIsQuitting()) {
          mainWindow.webContents.send(IPC_CHANNELS.RESOURCE_STATE_CHANGED, {
            isPaused: false,
            reason: null,
            conditions: [],
          });
        }

        updateTrayMenu();
      },
      onQuit: async () => {
        if (await confirmQuitIfBusy()) {
          await getRunnerManager()?.stop();
          app.quit();
        }
      },
    },
    findAsset
  );
  trayManager.create();
  setTrayManager(trayManager);
  updateTrayMenu();
};

/**
 * Update the tray menu and icon based on current status.
 */
export const updateTrayMenu = (): void => {
  const trayManager = getTrayManager();
  const runnerManager = getRunnerManager();
  const authState = getAuthState();
  const powerSaveBlockerId = getPowerSaveBlockerId();
  const brokerProxyService = getBrokerProxyService();
  const pauseState = getEffectivePauseState();
  const mainWindow = getMainWindow();

  const runnerStatus = runnerManager?.getStatus();

  // If all targets have active sessions, show as 'listening' even if
  // no workers are spawned yet (they spawn on-demand when jobs arrive)
  let effectiveStatus = runnerStatus?.status;
  if (brokerProxyService) {
    const proxyStatuses = brokerProxyService.getStatus();
    if (proxyStatuses.length > 0) {
      const allSessionsActive = proxyStatuses.every(s => s.sessionActive);
      if (allSessionsActive && effectiveStatus === 'offline') {
        effectiveStatus = 'listening';
      }
    }
  }

  const status: TrayStatusInfo = {
    isAuthenticated: !!authState,
    isConfigured: runnerManager?.isConfigured() ?? false,
    runnerStatus: effectiveStatus,
    isBusy: runnerStatus?.status === 'busy',
    isSleepBlocked: powerSaveBlockerId !== null,
    isPaused: pauseState.isPaused,
    pauseReason: pauseState.reason,
    isWindowVisible: mainWindow?.isVisible() ?? false,
  };
  trayManager?.updateMenu(status);
};
