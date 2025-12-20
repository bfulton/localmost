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
} from './app-state';
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
      onHide: () => {
        const mainWindow = getMainWindow();
        mainWindow?.hide();
        // Ensure dock icon stays visible on macOS
        if (process.platform === 'darwin' && app.dock) {
          app.dock.show();
        }
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

  const runnerStatus = runnerManager?.getStatus();
  const status: TrayStatusInfo = {
    isAuthenticated: !!authState,
    isConfigured: runnerManager?.isConfigured() ?? false,
    runnerStatus: runnerStatus?.status,
    isBusy: runnerStatus?.status === 'busy',
    isSleepBlocked: powerSaveBlockerId !== null,
  };
  trayManager?.updateMenu(status);
};
