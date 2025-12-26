 
import { jest } from '@jest/globals';

// Mock electron
const mockHandle = jest.fn<(channel: string, handler: (...args: any[]) => any) => void>();
jest.mock('electron', () => ({
  ipcMain: {
    handle: mockHandle,
  },
}));

// Mock auto-updater
const mockCheckForUpdates = jest.fn<() => Promise<void>>();
const mockDownloadUpdate = jest.fn<() => Promise<void>>();
const mockInstallUpdate = jest.fn<() => void>();
const mockGetUpdateStatus = jest.fn<() => any>();

jest.mock('../auto-updater', () => ({
  checkForUpdates: mockCheckForUpdates,
  downloadUpdate: mockDownloadUpdate,
  installUpdate: mockInstallUpdate,
  getUpdateStatus: mockGetUpdateStatus,
}));

import { registerUpdateHandlers } from './updater';
import { IPC_CHANNELS } from '../../shared/types';

describe('updater IPC handlers', () => {
  let handlers: Record<string, (...args: any[]) => any>;

  beforeEach(() => {
    jest.clearAllMocks();
    handlers = {};

    // Capture the handlers when registered
    mockHandle.mockImplementation((channel, handler) => {
      handlers[channel] = handler;
    });

    registerUpdateHandlers();
  });

  describe('update:check', () => {
    it('should register handler', () => {
      expect(handlers[IPC_CHANNELS.UPDATE_CHECK]).toBeDefined();
    });

    it('should call checkForUpdates and return success', async () => {
      mockCheckForUpdates.mockResolvedValue(undefined);

      const result = await handlers[IPC_CHANNELS.UPDATE_CHECK]();

      expect(mockCheckForUpdates).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it('should return error on failure', async () => {
      mockCheckForUpdates.mockRejectedValue(new Error('Network error'));

      const result = await handlers[IPC_CHANNELS.UPDATE_CHECK]();

      expect(result).toEqual({ success: false, error: 'Network error' });
    });
  });

  describe('update:download', () => {
    it('should register handler', () => {
      expect(handlers[IPC_CHANNELS.UPDATE_DOWNLOAD]).toBeDefined();
    });

    it('should call downloadUpdate and return success', async () => {
      mockDownloadUpdate.mockResolvedValue(undefined);

      const result = await handlers[IPC_CHANNELS.UPDATE_DOWNLOAD]();

      expect(mockDownloadUpdate).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it('should return error on failure', async () => {
      mockDownloadUpdate.mockRejectedValue(new Error('Download failed'));

      const result = await handlers[IPC_CHANNELS.UPDATE_DOWNLOAD]();

      expect(result).toEqual({ success: false, error: 'Download failed' });
    });
  });

  describe('update:install', () => {
    it('should register handler', () => {
      expect(handlers[IPC_CHANNELS.UPDATE_INSTALL]).toBeDefined();
    });

    it('should call installUpdate and return success', () => {
      const result = handlers[IPC_CHANNELS.UPDATE_INSTALL]();

      expect(mockInstallUpdate).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it('should return error on failure', () => {
      mockInstallUpdate.mockImplementation(() => {
        throw new Error('Install failed');
      });

      const result = handlers[IPC_CHANNELS.UPDATE_INSTALL]();

      expect(result).toEqual({ success: false, error: 'Install failed' });
    });
  });

  describe('update:get-status', () => {
    it('should register handler', () => {
      expect(handlers[IPC_CHANNELS.UPDATE_GET_STATUS]).toBeDefined();
    });

    it('should return current update status', () => {
      const mockStatus = {
        status: 'available',
        currentVersion: '1.0.0',
        availableVersion: '2.0.0',
      };
      mockGetUpdateStatus.mockReturnValue(mockStatus);

      const result = handlers[IPC_CHANNELS.UPDATE_GET_STATUS]();

      expect(mockGetUpdateStatus).toHaveBeenCalled();
      expect(result).toEqual(mockStatus);
    });
  });
});
