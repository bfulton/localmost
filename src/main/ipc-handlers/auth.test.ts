import { jest } from '@jest/globals';

// Mock electron
const mockHandle = jest.fn<(channel: string, handler: (...args: any[]) => any) => void>();
jest.mock('electron', () => ({
  ipcMain: {
    handle: mockHandle,
  },
  shell: {
    openExternal: jest.fn(),
  },
  clipboard: {
    writeText: jest.fn(),
  },
}));

// Mock store
const mockSetUser = jest.fn();
const mockSetDeviceCode = jest.fn();
const mockSetIsAuthenticating = jest.fn();
const mockLogout = jest.fn();
const mockSetRepos = jest.fn();
const mockSetOrgs = jest.fn();
jest.mock('../store/init', () => ({
  store: {
    getState: () => ({
      setUser: mockSetUser,
      setDeviceCode: mockSetDeviceCode,
      setIsAuthenticating: mockSetIsAuthenticating,
      logout: mockLogout,
      setRepos: mockSetRepos,
      setOrgs: mockSetOrgs,
    }),
  },
}));

// Mock GitHubAuth
const mockWaitForAuth = jest.fn<() => Promise<any>>();
const mockStartDeviceFlow = jest.fn<() => Promise<any>>();
jest.mock('../github-auth', () => ({
  GitHubAuth: jest.fn().mockImplementation(() => ({
    startDeviceFlow: mockStartDeviceFlow,
    abortPolling: jest.fn(),
  })),
  DEFAULT_CLIENT_ID: 'test-client-id',
}));

// Mock other dependencies
jest.mock('../config', () => ({
  loadConfig: jest.fn(() => ({})),
  saveConfig: jest.fn(),
}));

jest.mock('../auth-tokens', () => ({
  getValidAccessToken: jest.fn(),
}));

jest.mock('../app-state', () => ({
  getGitHubAuth: jest.fn(),
  setGitHubAuth: jest.fn(),
  getAuthState: jest.fn(),
  setAuthState: jest.fn(),
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock('../tray-init', () => ({
  updateTrayMenu: jest.fn(),
}));

import { registerAuthHandlers } from './auth';
import { clipboard } from 'electron';

describe('auth IPC handlers', () => {
  let handlers: Record<string, (...args: any[]) => any>;

  beforeEach(() => {
    jest.clearAllMocks();
    handlers = {};

    // Capture the handlers when registered
    mockHandle.mockImplementation((channel, handler) => {
      handlers[channel] = handler;
    });

    registerAuthHandlers();
  });

  describe('github:auth-device-flow', () => {
    const mockUser = { login: 'testuser', id: 123, avatar_url: 'https://example.com/avatar.png' };

    beforeEach(() => {
      mockStartDeviceFlow.mockResolvedValue({
        status: {
          userCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
        },
        waitForAuth: mockWaitForAuth,
      });
    });

    it('should set user in store after successful auth', async () => {
      mockWaitForAuth.mockResolvedValue({
        user: mockUser,
        accessToken: 'test-token',
      });

      const result = await handlers['github:auth-device-flow']();

      expect(result.success).toBe(true);
      expect(result.user).toEqual(mockUser);
      expect(mockSetUser).toHaveBeenCalledWith(mockUser);
    });

    it('should copy device code to clipboard', async () => {
      mockWaitForAuth.mockResolvedValue({
        user: mockUser,
        accessToken: 'test-token',
      });

      await handlers['github:auth-device-flow']();

      expect(clipboard.writeText).toHaveBeenCalledWith('ABCD-1234');
    });

    it('should set device code with copiedToClipboard flag', async () => {
      mockWaitForAuth.mockResolvedValue({
        user: mockUser,
        accessToken: 'test-token',
      });

      await handlers['github:auth-device-flow']();

      expect(mockSetDeviceCode).toHaveBeenCalledWith({
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        copiedToClipboard: true,
      });
    });

    it('should clear device code after successful auth', async () => {
      mockWaitForAuth.mockResolvedValue({
        user: mockUser,
        accessToken: 'test-token',
      });

      await handlers['github:auth-device-flow']();

      // First call sets the device code, second call clears it
      expect(mockSetDeviceCode).toHaveBeenLastCalledWith(null);
    });

    it('should clear auth state on error', async () => {
      mockWaitForAuth.mockRejectedValue(new Error('Auth failed'));

      const result = await handlers['github:auth-device-flow']();

      expect(result.success).toBe(false);
      expect(mockSetDeviceCode).toHaveBeenLastCalledWith(null);
      expect(mockSetIsAuthenticating).toHaveBeenLastCalledWith(false);
    });
  });

  describe('github:auth-logout', () => {
    it('should call logout on store', () => {
      handlers['github:auth-logout']();

      expect(mockLogout).toHaveBeenCalled();
    });
  });

  describe('github:auth-cancel', () => {
    it('should clear device code and auth state', () => {
      handlers['github:auth-cancel']();

      expect(mockSetDeviceCode).toHaveBeenCalledWith(null);
      expect(mockSetIsAuthenticating).toHaveBeenCalledWith(false);
    });
  });
});
