/**
 * IPC handlers for general app control.
 */

import * as os from 'os';
import { app, ipcMain, net } from 'electron';
import { getMainWindow, getRunnerManager, getHeartbeatManager } from '../app-state';
import { confirmQuitIfBusy } from '../window';
import { getLogSymlinkPath, sendLog } from '../logging';
import { IPC_CHANNELS, LogEntry, HeartbeatStatus } from '../../shared/types';

/**
 * Register app-related IPC handlers.
 */
export const registerAppHandlers = (): void => {
  // App control
  ipcMain.on(IPC_CHANNELS.APP_MINIMIZE_TO_TRAY, () => {
    const mainWindow = getMainWindow();
    mainWindow?.hide();
    // Ensure dock icon stays visible on macOS
    if (process.platform === 'darwin' && app.dock) {
      app.dock.show();
    }
  });

  ipcMain.on(IPC_CHANNELS.APP_QUIT, async () => {
    if (await confirmQuitIfBusy()) {
      await getRunnerManager()?.stop();
      app.quit();
    }
  });

  ipcMain.handle(IPC_CHANNELS.APP_GET_HOSTNAME, () => {
    return os.hostname().replace(/\.local$/, '');
  });

  ipcMain.handle(IPC_CHANNELS.APP_GET_CPU_COUNT, () => {
    return os.cpus().length;
  });

  // Log file path
  ipcMain.handle(IPC_CHANNELS.LOG_GET_PATH, () => {
    return getLogSymlinkPath();
  });

  // Write log entry (from renderer)
  ipcMain.handle(IPC_CHANNELS.LOG_WRITE, (_event, entry: LogEntry) => {
    sendLog(entry);
  });

  // Heartbeat status
  ipcMain.handle(IPC_CHANNELS.HEARTBEAT_GET_STATUS, (): HeartbeatStatus => {
    const heartbeatManager = getHeartbeatManager();
    return {
      isRunning: heartbeatManager?.isRunning() ?? false,
    };
  });

  // Network status
  ipcMain.handle(IPC_CHANNELS.NETWORK_GET_STATUS, () => {
    return net.isOnline();
  });
};
