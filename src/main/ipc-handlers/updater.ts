/**
 * IPC handlers for auto-update operations.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types';
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  getUpdateStatus,
} from '../auto-updater';

/**
 * Register IPC handlers for update operations.
 */
export function registerUpdateHandlers(): void {
  // Check for updates
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    try {
      await checkForUpdates();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Download available update
  ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, async () => {
    try {
      await downloadUpdate();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Install downloaded update (quits and restarts)
  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, () => {
    try {
      installUpdate();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get current update status
  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_STATUS, () => {
    return getUpdateStatus();
  });
}
