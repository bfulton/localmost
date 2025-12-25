/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest } from '@jest/globals';
import type { EventEmitter } from 'events';

// Mock electron (electron-updater is mocked via jest.config.js moduleNameMapper)
jest.mock('electron', () => ({
  app: {
    getVersion: jest.fn().mockReturnValue('1.0.0'),
  },
  BrowserWindow: jest.fn(),
}));

// Mock app-state
jest.mock('./app-state', () => ({
  getIsQuitting: jest.fn().mockReturnValue(false),
  getLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

type MockAutoUpdater = EventEmitter & {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates: jest.Mock;
  downloadUpdate: jest.Mock;
  quitAndInstall: jest.Mock;
};

import { app, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../shared/types';

describe('auto-updater', () => {
  let mockMainWindow: {
    isDestroyed: jest.Mock;
    webContents: {
      send: jest.Mock;
    };
  };

  // Re-import module functions for each test to reset module state
  let initAutoUpdater: typeof import('./auto-updater').initAutoUpdater;
  let checkForUpdates: typeof import('./auto-updater').checkForUpdates;
  let downloadUpdate: typeof import('./auto-updater').downloadUpdate;
  let installUpdate: typeof import('./auto-updater').installUpdate;
  let getUpdateStatus: typeof import('./auto-updater').getUpdateStatus;
  let resetForTesting: typeof import('./auto-updater').resetForTesting;
  let mockGetIsQuitting: jest.Mock;
  let mockAutoUpdater: MockAutoUpdater;

  beforeEach(() => {
    jest.clearAllMocks();

    // Get fresh reference to the mock autoUpdater (persisted via global singleton)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronUpdaterModule = require('electron-updater');
    mockAutoUpdater = electronUpdaterModule.autoUpdater as MockAutoUpdater;

    // Reset autoUpdater state - remove all listeners so initAutoUpdater can re-register
    mockAutoUpdater.removeAllListeners();
    mockAutoUpdater.autoDownload = true;
    mockAutoUpdater.autoInstallOnAppQuit = false;
    (mockAutoUpdater.checkForUpdates as jest.Mock).mockClear();
    (mockAutoUpdater.downloadUpdate as jest.Mock).mockClear();
    (mockAutoUpdater.quitAndInstall as jest.Mock).mockClear();

    // Get module functions (cached, but listeners are reset above)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const autoUpdaterModule = require('./auto-updater');
    initAutoUpdater = autoUpdaterModule.initAutoUpdater;
    checkForUpdates = autoUpdaterModule.checkForUpdates;
    downloadUpdate = autoUpdaterModule.downloadUpdate;
    installUpdate = autoUpdaterModule.installUpdate;
    getUpdateStatus = autoUpdaterModule.getUpdateStatus;
    resetForTesting = autoUpdaterModule.resetForTesting;

    // Reset module state for test isolation
    resetForTesting();

    // Get reference to the mocked getIsQuitting
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const appStateModule = require('./app-state');
    mockGetIsQuitting = appStateModule.getIsQuitting as jest.Mock;

    // Create mock window
    mockMainWindow = {
      isDestroyed: jest.fn().mockReturnValue(false),
      webContents: {
        send: jest.fn(),
      },
    };

    mockGetIsQuitting.mockReturnValue(false);
    (app.getVersion as jest.Mock).mockReturnValue('1.0.0');
  });

  describe('initAutoUpdater', () => {
    it('should set current version from app', () => {
      initAutoUpdater(mockMainWindow as unknown as BrowserWindow);

      const status = getUpdateStatus();
      expect(status.currentVersion).toBe('1.0.0');
    });

    it('should disable autoDownload', () => {
      initAutoUpdater(mockMainWindow as unknown as BrowserWindow);

      expect(mockAutoUpdater.autoDownload).toBe(false);
    });

    it('should enable autoInstallOnAppQuit', () => {
      initAutoUpdater(mockMainWindow as unknown as BrowserWindow);

      expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(true);
    });

    it('should register event handlers', () => {
      initAutoUpdater(mockMainWindow as unknown as BrowserWindow);

      expect(mockAutoUpdater.listenerCount('checking-for-update')).toBe(1);
      expect(mockAutoUpdater.listenerCount('update-available')).toBe(1);
      expect(mockAutoUpdater.listenerCount('update-not-available')).toBe(1);
      expect(mockAutoUpdater.listenerCount('download-progress')).toBe(1);
      expect(mockAutoUpdater.listenerCount('update-downloaded')).toBe(1);
      expect(mockAutoUpdater.listenerCount('error')).toBe(1);
    });
  });

  describe('Event Handlers', () => {
    beforeEach(() => {
      initAutoUpdater(mockMainWindow as unknown as BrowserWindow);
    });

    it('should update status on checking-for-update', () => {
      mockAutoUpdater.emit('checking-for-update');

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.UPDATE_STATUS,
        expect.objectContaining({ status: 'checking' })
      );
    });

    it('should update status on update-available', () => {
      mockAutoUpdater.emit('update-available', {
        version: '2.0.0',
        releaseNotes: 'New features',
        releaseDate: '2024-01-01',
      });

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.UPDATE_STATUS,
        expect.objectContaining({
          status: 'available',
          availableVersion: '2.0.0',
          releaseNotes: 'New features',
          releaseDate: '2024-01-01',
        })
      );
    });

    it('should update status on update-not-available', () => {
      mockAutoUpdater.emit('update-not-available');

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.UPDATE_STATUS,
        expect.objectContaining({ status: 'idle' })
      );
    });

    it('should update status on download-progress', () => {
      mockAutoUpdater.emit('download-progress', {
        percent: 45.678,
        bytesPerSecond: 1000000,
        total: 50000000,
        transferred: 22839000,
      });

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.UPDATE_STATUS,
        expect.objectContaining({
          status: 'downloading',
          downloadProgress: 46, // Rounded
          bytesPerSecond: 1000000,
          totalBytes: 50000000,
          transferredBytes: 22839000,
        })
      );
    });

    it('should update status on update-downloaded', () => {
      mockAutoUpdater.emit('update-downloaded', {
        version: '2.0.0',
      });

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.UPDATE_STATUS,
        expect.objectContaining({
          status: 'downloaded',
          availableVersion: '2.0.0',
        })
      );
    });

    it('should update status on error', () => {
      mockAutoUpdater.emit('error', new Error('Network error'));

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.UPDATE_STATUS,
        expect.objectContaining({
          status: 'error',
          error: 'Network error',
        })
      );
    });

    it('should not send to window if destroyed', () => {
      mockMainWindow.isDestroyed.mockReturnValue(true);

      mockAutoUpdater.emit('update-available', { version: '2.0.0' });

      expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('should not send to window if app is quitting', () => {
      mockGetIsQuitting.mockReturnValue(true);

      mockAutoUpdater.emit('update-available', { version: '2.0.0' });

      expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('Release Notes Formatting', () => {
    beforeEach(() => {
      initAutoUpdater(mockMainWindow as unknown as BrowserWindow);
    });

    it('should handle string release notes', () => {
      mockAutoUpdater.emit('update-available', {
        version: '2.0.0',
        releaseNotes: 'Simple string notes',
      });

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.UPDATE_STATUS,
        expect.objectContaining({
          releaseNotes: 'Simple string notes',
        })
      );
    });

    it('should handle array release notes', () => {
      mockAutoUpdater.emit('update-available', {
        version: '2.0.0',
        releaseNotes: [
          { version: '2.0.0', note: 'First note' },
          { version: '1.5.0', note: 'Second note' },
        ],
      });

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.UPDATE_STATUS,
        expect.objectContaining({
          releaseNotes: 'First note\n\nSecond note',
        })
      );
    });

    it('should handle null release notes', () => {
      mockAutoUpdater.emit('update-available', {
        version: '2.0.0',
        releaseNotes: null,
      });

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.UPDATE_STATUS,
        expect.objectContaining({
          releaseNotes: undefined,
        })
      );
    });

    it('should handle undefined release notes', () => {
      mockAutoUpdater.emit('update-available', {
        version: '2.0.0',
      });

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.UPDATE_STATUS,
        expect.objectContaining({
          releaseNotes: undefined,
        })
      );
    });
  });

  describe('checkForUpdates', () => {
    it('should call autoUpdater.checkForUpdates', async () => {
      await checkForUpdates();

      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled();
    });
  });

  describe('downloadUpdate', () => {
    it('should call autoUpdater.downloadUpdate', async () => {
      await downloadUpdate();

      expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalled();
    });
  });

  describe('installUpdate', () => {
    it('should call autoUpdater.quitAndInstall with correct args', () => {
      installUpdate();

      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    });
  });

  describe('getUpdateStatus', () => {
    it('should return current status', () => {
      initAutoUpdater(mockMainWindow as unknown as BrowserWindow);

      const status = getUpdateStatus();

      expect(status.status).toBe('idle');
      expect(status.currentVersion).toBe('1.0.0');
    });

    it('should return a copy of status', () => {
      initAutoUpdater(mockMainWindow as unknown as BrowserWindow);

      const status1 = getUpdateStatus();
      const status2 = getUpdateStatus();

      expect(status1).not.toBe(status2);
      expect(status1).toEqual(status2);
    });
  });

  describe('Status Persistence', () => {
    beforeEach(() => {
      initAutoUpdater(mockMainWindow as unknown as BrowserWindow);
    });

    it('should accumulate status updates', () => {
      mockAutoUpdater.emit('update-available', {
        version: '2.0.0',
        releaseNotes: 'Notes',
      });

      let status = getUpdateStatus();
      expect(status.status).toBe('available');
      expect(status.availableVersion).toBe('2.0.0');
      expect(status.currentVersion).toBe('1.0.0');

      mockAutoUpdater.emit('download-progress', {
        percent: 50,
        bytesPerSecond: 1000,
        total: 100,
        transferred: 50,
      });

      status = getUpdateStatus();
      expect(status.status).toBe('downloading');
      expect(status.downloadProgress).toBe(50);
      // Should still have previous fields
      expect(status.currentVersion).toBe('1.0.0');
    });
  });
});
