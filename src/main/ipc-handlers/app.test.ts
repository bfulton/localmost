/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest } from '@jest/globals';
import * as os from 'os';

// Mock os
jest.mock('os', () => ({
  hostname: jest.fn(),
  cpus: jest.fn(),
}));

// Mock electron
const mockOn = jest.fn<(channel: string, handler: (...args: any[]) => any) => void>();
const mockHandle = jest.fn<(channel: string, handler: (...args: any[]) => any) => void>();
jest.mock('electron', () => ({
  app: {
    dock: {
      show: jest.fn(),
    },
    quit: jest.fn(),
  },
  ipcMain: {
    on: mockOn,
    handle: mockHandle,
  },
  net: {
    isOnline: jest.fn(),
  },
}));

// Mock dependencies
jest.mock('../app-state', () => ({
  getMainWindow: jest.fn(),
  getRunnerManager: jest.fn(),
  getHeartbeatManager: jest.fn(),
}));

jest.mock('../window', () => ({
  confirmQuitIfBusy: jest.fn(),
}));

jest.mock('../logging', () => ({
  getLogSymlinkPath: jest.fn(),
  sendLog: jest.fn(),
}));

import { app, net } from 'electron';
import { registerAppHandlers } from './app';
import { getMainWindow, getRunnerManager, getHeartbeatManager } from '../app-state';
import { confirmQuitIfBusy } from '../window';
import { getLogSymlinkPath, sendLog } from '../logging';

describe('app IPC handlers', () => {
  let onHandlers: Record<string, (...args: any[]) => any>;
  let handleHandlers: Record<string, (...args: any[]) => any>;

  beforeEach(() => {
    jest.clearAllMocks();
    onHandlers = {};
    handleHandlers = {};

    mockOn.mockImplementation((channel, handler) => {
      onHandlers[channel] = handler;
    });

    mockHandle.mockImplementation((channel, handler) => {
      handleHandlers[channel] = handler;
    });

    registerAppHandlers();
  });

  describe('app:minimize-to-tray', () => {
    it('should hide the main window', () => {
      const mockWindow = { hide: jest.fn() };
      (getMainWindow as jest.MockedFunction<typeof getMainWindow>).mockReturnValue(mockWindow as any);

      onHandlers['app:minimize-to-tray']();

      expect(mockWindow.hide).toHaveBeenCalled();
    });

    it('should show dock on macOS', () => {
      const mockWindow = { hide: jest.fn() };
      (getMainWindow as jest.MockedFunction<typeof getMainWindow>).mockReturnValue(mockWindow as any);
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      onHandlers['app:minimize-to-tray']();

      expect(app.dock!.show).toHaveBeenCalled();
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('should handle no main window', () => {
      (getMainWindow as jest.MockedFunction<typeof getMainWindow>).mockReturnValue(null);

      expect(() => onHandlers['app:minimize-to-tray']()).not.toThrow();
    });
  });

  describe('app:quit', () => {
    it('should confirm and quit if not busy', async () => {
      (confirmQuitIfBusy as jest.MockedFunction<typeof confirmQuitIfBusy>).mockResolvedValue(true);
      const mockManager = { stop: jest.fn() };
      (getRunnerManager as jest.MockedFunction<typeof getRunnerManager>).mockReturnValue(mockManager as any);

      await onHandlers['app:quit']();

      expect(mockManager.stop).toHaveBeenCalled();
      expect(app.quit).toHaveBeenCalled();
    });

    it('should not quit if user cancels', async () => {
      (confirmQuitIfBusy as jest.MockedFunction<typeof confirmQuitIfBusy>).mockResolvedValue(false);

      await onHandlers['app:quit']();

      expect(app.quit).not.toHaveBeenCalled();
    });

    it('should handle no runner manager', async () => {
      (confirmQuitIfBusy as jest.MockedFunction<typeof confirmQuitIfBusy>).mockResolvedValue(true);
      (getRunnerManager as jest.MockedFunction<typeof getRunnerManager>).mockReturnValue(null);

      await onHandlers['app:quit']();

      expect(app.quit).toHaveBeenCalled();
    });
  });

  describe('app:get-hostname', () => {
    it('should return hostname without .local suffix', () => {
      (os.hostname as jest.MockedFunction<typeof os.hostname>).mockReturnValue('my-computer.local');

      const result = handleHandlers['app:get-hostname']();

      expect(result).toBe('my-computer');
    });

    it('should return hostname as-is if no .local suffix', () => {
      (os.hostname as jest.MockedFunction<typeof os.hostname>).mockReturnValue('server123');

      const result = handleHandlers['app:get-hostname']();

      expect(result).toBe('server123');
    });
  });

  describe('app:get-cpu-count', () => {
    it('should return CPU count', () => {
      (os.cpus as jest.MockedFunction<typeof os.cpus>).mockReturnValue(new Array(8) as any);

      const result = handleHandlers['app:get-cpu-count']();

      expect(result).toBe(8);
    });
  });

  describe('log:get-path', () => {
    it('should return log symlink path', () => {
      (getLogSymlinkPath as jest.MockedFunction<typeof getLogSymlinkPath>).mockReturnValue('/var/log/localmost.log');

      const result = handleHandlers['log:get-path']();

      expect(result).toBe('/var/log/localmost.log');
    });
  });

  describe('log:write', () => {
    it('should forward log entry to sendLog', () => {
      const entry = { timestamp: '2024-01-01T00:00:00Z', level: 'info', message: 'Test' };

      handleHandlers['log:write']({}, entry);

      expect(sendLog).toHaveBeenCalledWith(entry);
    });
  });

  describe('heartbeat:get-status', () => {
    it('should return running status', () => {
      const mockHeartbeat = { isRunning: jest.fn().mockReturnValue(true) };
      (getHeartbeatManager as jest.MockedFunction<typeof getHeartbeatManager>).mockReturnValue(mockHeartbeat as any);

      const result = handleHandlers['heartbeat:get-status']();

      expect(result).toEqual({ isRunning: true });
    });

    it('should return false when no heartbeat manager', () => {
      (getHeartbeatManager as jest.MockedFunction<typeof getHeartbeatManager>).mockReturnValue(null);

      const result = handleHandlers['heartbeat:get-status']();

      expect(result).toEqual({ isRunning: false });
    });
  });

  describe('network:get-status', () => {
    it('should return online status', () => {
      (net.isOnline as jest.MockedFunction<typeof net.isOnline>).mockReturnValue(true);

      const result = handleHandlers['network:get-status']();

      expect(result).toBe(true);
    });

    it('should return offline status', () => {
      (net.isOnline as jest.MockedFunction<typeof net.isOnline>).mockReturnValue(false);

      const result = handleHandlers['network:get-status']();

      expect(result).toBe(false);
    });
  });
});
