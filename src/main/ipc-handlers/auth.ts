/**
 * IPC handlers for GitHub authentication.
 */

import { ipcMain, shell } from 'electron';
import { GitHubAuth, DEFAULT_CLIENT_ID } from '../github-auth';
import { toUserError } from '../user-error';
import { loadConfig, saveConfig } from '../config';
import { getValidAccessToken } from '../auth-tokens';
import {
  getMainWindow,
  getGitHubAuth,
  setGitHubAuth,
  getAuthState,
  setAuthState,
  getLogger,
} from '../app-state';
import { updateTrayMenu } from '../tray-init';
import { IPC_CHANNELS, GitHubRepo, GitHubUserSearchResult } from '../../shared/types';

/**
 * Register authentication-related IPC handlers.
 */
export const registerAuthHandlers = (): void => {
  const logger = getLogger();

  // GitHub auth - Device Flow
  ipcMain.handle(IPC_CHANNELS.GITHUB_AUTH_START, async () => {
    const config = loadConfig();
    const clientId = config.githubClientId || DEFAULT_CLIENT_ID;

    try {
      const githubAuth = new GitHubAuth(clientId);
      setGitHubAuth(githubAuth);
      const { status } = await githubAuth.startDeviceFlow();

      // Return the device code info immediately
      // The renderer will call GITHUB_AUTH_POLL to wait for completion
      return {
        success: true,
        deviceFlow: {
          userCode: status.userCode,
          verificationUri: status.verificationUri,
        },
      };
    } catch (error) {
      const { userMessage, technicalDetails } = toUserError(error, 'Authentication');
      logger?.error(technicalDetails);
      return { success: false, error: userMessage };
    }
  });

  // Start polling for auth completion (called after user sees the code)
  ipcMain.handle(IPC_CHANNELS.GITHUB_AUTH_POLL, async () => {
    const githubAuth = getGitHubAuth();
    if (!githubAuth) {
      return { success: false, error: 'Auth not started' };
    }

    try {
      const { status, waitForAuth } = await githubAuth.startDeviceFlow();

      // Open the verification URL
      shell.openExternal(status.verificationUri);

      // Wait for user to complete auth
      const result = await waitForAuth();
      setAuthState(result);
      updateTrayMenu();

      return { success: true, user: result.user };
    } catch (error) {
      const { userMessage, technicalDetails } = toUserError(error, 'Authentication');
      logger?.error(technicalDetails);
      return { success: false, error: userMessage };
    }
  });

  // Combined: start device flow, open browser, poll for completion
  ipcMain.handle(IPC_CHANNELS.GITHUB_AUTH_DEVICE_FLOW, async () => {
    const config = loadConfig();
    const clientId = config.githubClientId || DEFAULT_CLIENT_ID;

    try {
      const githubAuth = new GitHubAuth(clientId);
      setGitHubAuth(githubAuth);
      const { status, waitForAuth } = await githubAuth.startDeviceFlow();

      // Send the code to the renderer to display
      const mainWindow = getMainWindow();
      mainWindow?.webContents.send(IPC_CHANNELS.GITHUB_DEVICE_CODE, {
        userCode: status.userCode,
        verificationUri: status.verificationUri,
      });

      // Open the verification URL in the browser
      shell.openExternal(status.verificationUri);

      // Wait for user to complete auth
      const result = await waitForAuth();
      setAuthState(result);
      updateTrayMenu();

      // Save auth to config
      const currentConfig = loadConfig();
      currentConfig.auth = result;
      saveConfig(currentConfig);

      return { success: true, user: result.user };
    } catch (error) {
      const { userMessage, technicalDetails } = toUserError(error, 'Authentication');
      logger?.error(technicalDetails);
      return { success: false, error: userMessage };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GITHUB_AUTH_CANCEL, () => {
    const githubAuth = getGitHubAuth();
    githubAuth?.abortPolling();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.GITHUB_AUTH_STATUS, () => {
    const authState = getAuthState();
    return {
      isAuthenticated: !!authState,
      user: authState?.user,
    };
  });

  ipcMain.handle(IPC_CHANNELS.GITHUB_AUTH_LOGOUT, () => {
    setAuthState(null);
    // Clear saved auth
    const config = loadConfig();
    delete config.auth;
    saveConfig(config);
    updateTrayMenu();
    return { success: true };
  });

  // Get repos where the GitHub App is installed
  ipcMain.handle(IPC_CHANNELS.GITHUB_GET_REPOS, async (): Promise<{ success: boolean; repos?: GitHubRepo[]; error?: string }> => {
    const accessToken = await getValidAccessToken();
    const githubAuth = getGitHubAuth();
    if (!accessToken || !githubAuth) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      const repos = await githubAuth.getInstalledRepos(accessToken);
      return { success: true, repos };
    } catch (error) {
      const { userMessage, technicalDetails } = toUserError(error, 'Fetching repositories');
      logger?.error(technicalDetails);
      return { success: false, error: userMessage };
    }
  });

  // Get orgs where the GitHub App is installed
  ipcMain.handle(IPC_CHANNELS.GITHUB_GET_ORGS, async (): Promise<{ success: boolean; orgs?: { id: number; login: string; avatar_url: string }[]; error?: string }> => {
    const accessToken = await getValidAccessToken();
    const githubAuth = getGitHubAuth();
    if (!accessToken || !githubAuth) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      const orgs = await githubAuth.getInstalledOrgs(accessToken);
      return { success: true, orgs };
    } catch (error) {
      const { userMessage, technicalDetails } = toUserError(error, 'Fetching organizations');
      logger?.error(technicalDetails);
      return { success: false, error: userMessage };
    }
  });

  // Search for GitHub users
  ipcMain.handle(IPC_CHANNELS.GITHUB_SEARCH_USERS, async (_event, query: string): Promise<{ success: boolean; users?: GitHubUserSearchResult[]; error?: string }> => {
    const accessToken = await getValidAccessToken();
    const githubAuth = getGitHubAuth();
    if (!accessToken || !githubAuth) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      const users = await githubAuth.searchUsers(accessToken, query);
      return { success: true, users };
    } catch (error) {
      const { userMessage, technicalDetails } = toUserError(error, 'Searching users');
      logger?.error(technicalDetails);
      return { success: false, error: userMessage };
    }
  });
};
