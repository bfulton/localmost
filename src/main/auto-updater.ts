/**
 * Auto-updater module for managing app updates via electron-updater.
 * Uses GitHub Releases as the update source.
 */

import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';
import { BrowserWindow, app } from 'electron';
import { IPC_CHANNELS, UpdateStatus } from '../shared/types';
import { getIsQuitting, getLogger } from './app-state';

// Update state that gets sent to renderer
let currentStatus: UpdateStatus = {
  status: 'idle',
  currentVersion: '',
};

/**
 * Initialize the auto-updater module.
 * Sets up event handlers and configures update source.
 */
export function initAutoUpdater(mainWindow: BrowserWindow): void {
  // Set current version
  currentStatus.currentVersion = app.getVersion();

  // Configure update source - uses GitHub Releases
  // Repository is auto-detected from package.json "repository" field
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // Redirect electron-updater logs to our logger instead of stdout
  const logger = getLogger();
  autoUpdater.logger = {
    info: (message: string) => logger?.info(`[updater] ${message}`),
    warn: (message: string) => logger?.warn(`[updater] ${message}`),
    error: (message: string) => logger?.error(`[updater] ${message}`),
    debug: (message: string) => logger?.debug(`[updater] ${message}`),
  };

  // Set up event handlers
  autoUpdater.on('checking-for-update', () => {
    updateStatus(mainWindow, { status: 'checking' });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    updateStatus(mainWindow, {
      status: 'available',
      availableVersion: info.version,
      releaseNotes: formatReleaseNotes(info.releaseNotes),
      releaseDate: info.releaseDate,
    });
  });

  autoUpdater.on('update-not-available', () => {
    updateStatus(mainWindow, { status: 'idle' });
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    updateStatus(mainWindow, {
      status: 'downloading',
      downloadProgress: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
      totalBytes: progress.total,
      transferredBytes: progress.transferred,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    updateStatus(mainWindow, {
      status: 'downloaded',
      availableVersion: info.version,
    });
  });

  autoUpdater.on('error', (error: Error) => {
    updateStatus(mainWindow, {
      status: 'error',
      error: error.message,
    });
  });
}

/**
 * Check for available updates.
 */
export async function checkForUpdates(): Promise<void> {
  await autoUpdater.checkForUpdates();
}

/**
 * Download the available update.
 */
export async function downloadUpdate(): Promise<void> {
  await autoUpdater.downloadUpdate();
}

/**
 * Install the downloaded update and restart the app.
 */
export function installUpdate(): void {
  autoUpdater.quitAndInstall(false, true);
}

/**
 * Get the current update status.
 */
export function getUpdateStatus(): UpdateStatus {
  return { ...currentStatus };
}

/**
 * Reset the update status. For testing only.
 */
export function resetForTesting(): void {
  currentStatus = {
    status: 'idle',
    currentVersion: '',
  };
}

/**
 * Update the status and notify renderer.
 */
function updateStatus(mainWindow: BrowserWindow, update: Partial<UpdateStatus>): void {
  currentStatus = {
    ...currentStatus,
    ...update,
  };

  // Send to renderer if window is available and app isn't quitting
  if (mainWindow && !mainWindow.isDestroyed() && !getIsQuitting()) {
    mainWindow.webContents.send(IPC_CHANNELS.UPDATE_STATUS, currentStatus);
  }
}

/**
 * Format release notes from electron-updater format.
 */
function formatReleaseNotes(
  notes: string | ReleaseNoteInfo[] | null | undefined
): string | undefined {
  if (!notes) return undefined;

  if (typeof notes === 'string') {
    return notes;
  }

  // Array of release notes (for staged rollouts)
  if (Array.isArray(notes)) {
    return notes
      .map((n) => n.note)
      .filter((note): note is string => note !== null)
      .join('\n\n');
  }

  return undefined;
}

interface ReleaseNoteInfo {
  version: string;
  note: string | null;
}
