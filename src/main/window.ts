/**
 * Window management: creation, dialogs, and lifecycle.
 */

import { app, BrowserWindow, dialog, nativeImage, shell } from 'electron';
import {
  setMainWindow,
  getRunnerManager,
  getIsQuitting,
} from './app-state';
import { findAsset } from './log-file';
import { BUILD_INFO } from '../shared/build-info';
import { REPOSITORY_URL, PRIVACY_POLICY_URL } from '../shared/constants';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

/**
 * Create the main application window.
 */
export const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    title: 'localmost',
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // Set Content Security Policy
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self'; " +
          "style-src 'self'; " +
          "img-src 'self' data: https://avatars.githubusercontent.com; " +
          "connect-src 'self'; " +
          "font-src 'self'; " +
          "frame-src 'none'; " +
          "object-src 'none'"
        ]
      }
    });
  });

  // Open DevTools in development (slight delay to avoid sandbox_bundle.js errors)
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.openDevTools();
    });
  }

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Also handle navigation to external URLs
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow navigation within the app
    if (url.startsWith(MAIN_WINDOW_WEBPACK_ENTRY) || url.startsWith('file://')) {
      return;
    }
    // Open external URLs in default browser
    if (url.startsWith('http://') || url.startsWith('https://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('close', (event) => {
    // Always prevent window.close() - we destroy window explicitly after cleanup
    event.preventDefault();

    if (getIsQuitting()) {
      // Already shutting down, nothing to do (window will be destroyed via destroy())
      return;
    }

    const runnerManager = getRunnerManager();

    // If runner is active, ask user what they want to do
    if (runnerManager?.isRunning()) {
      dialog.showMessageBox({
        type: 'question',
        title: 'Keep Running in Background?',
        message: 'A GitHub Actions runner is active',
        detail: 'Would you like to keep localmost running in the background to continue processing jobs?',
        buttons: ['Keep Running', 'Stop Runner & Quit'],
        defaultId: 0,
        cancelId: 0,
      }).then(async (result) => {
        if (result.response === 0) {
          // User chose to keep running - minimize to tray
          mainWindow?.hide();
          // Ensure dock icon stays visible on macOS
          if (process.platform === 'darwin' && app.dock) {
            app.dock.show();
          }
        } else {
          // User chose to quit
          app.quit();
        }
      });
      return;
    }

    // Otherwise, start the quit process (which will destroy window after cleanup)
    app.quit();
  });

  mainWindow.on('closed', () => {
    setMainWindow(null);
  });

  setMainWindow(mainWindow);
};

/**
 * Show confirmation dialog if a job is currently running.
 * Returns true if user confirms they want to quit.
 */
export const confirmQuitIfBusy = async (): Promise<boolean> => {
  const runnerManager = getRunnerManager();
  const runnerStatus = runnerManager?.getStatus();
  if (runnerStatus?.status === 'busy') {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: 'Quit localmost?',
      message: 'A job is currently running',
      detail: 'Quitting now will cancel the running job. Are you sure you want to quit?',
      buttons: ['Cancel', 'Quit Anyway'],
      defaultId: 0,
      cancelId: 0,
    });
    return result.response === 1;
  }
  return true;
};

/**
 * Show the About dialog.
 */
export const showAboutDialog = (): void => {
  const buildDate = new Date(BUILD_INFO.buildTime);
  const formattedDate = buildDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const message = `Version ${app.getVersion()}

Built: ${formattedDate}
Branch: ${BUILD_INFO.branch}
Commit: ${BUILD_INFO.sha}`;

  const iconPath = findAsset('icon.png');
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : undefined;

  dialog.showMessageBox({
    type: 'info',
    title: 'About localmost',
    message: 'localmost',
    detail: message,
    buttons: ['OK', 'Privacy Policy', 'View on GitHub'],
    icon,
  }).then((result) => {
    if (result.response === 1) {
      shell.openExternal(PRIVACY_POLICY_URL);
    } else if (result.response === 2) {
      shell.openExternal(REPOSITORY_URL);
    }
  });
};

/**
 * Set the dock icon on macOS.
 */
export const setDockIcon = (): void => {
  // Only applicable on macOS
  if (process.platform !== 'darwin' || !app.dock) return;

  const iconPath = findAsset('icon.png');
  if (iconPath) {
    const icon = nativeImage.createFromPath(iconPath);
    app.dock.setIcon(icon);
  }
};
