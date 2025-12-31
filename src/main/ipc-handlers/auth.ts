/**
 * IPC handlers for GitHub authentication.
 */

import { ipcMain, shell, clipboard } from 'electron';
import { GitHubAuth, DEFAULT_CLIENT_ID } from '../github-auth';
import { toUserError } from '../user-error';
import { loadConfig, saveConfig } from '../config';
import { getValidAccessToken } from '../auth-tokens';
import {
  getGitHubAuth,
  setGitHubAuth,
  getAuthState,
  setAuthState,
  getLogger,
} from '../app-state';
import { updateTrayMenu } from '../tray-init';
import { IPC_CHANNELS, GitHubRepo, GitHubUserSearchResult } from '../../shared/types';
import { store } from '../store/init';

/**
 * Validate that a URL is a legitimate GitHub URL before opening externally.
 * This prevents phishing attacks if the GitHub API were compromised.
 */
function isValidGitHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com';
  } catch {
    return false;
  }
}

/**
 * Safely open a GitHub verification URL in the user's browser.
 * Validates the URL is actually GitHub before opening.
 */
function openGitHubVerificationUrl(url: string): void {
  if (isValidGitHubUrl(url)) {
    shell.openExternal(url);
  } else {
    getLogger()?.error(`Refusing to open suspicious verification URL: ${url}`);
  }
}

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

      // Open the verification URL (with validation)
      openGitHubVerificationUrl(status.verificationUri);

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
      // Mark auth as in progress
      store.getState().setIsAuthenticating(true);

      const githubAuth = new GitHubAuth(clientId);
      setGitHubAuth(githubAuth);
      const { status, waitForAuth } = await githubAuth.startDeviceFlow();

      // Copy code to clipboard for easy pasting
      clipboard.writeText(status.userCode);

      // Set device code in store (syncs to renderer via zubridge)
      store.getState().setDeviceCode({
        userCode: status.userCode,
        verificationUri: status.verificationUri,
        copiedToClipboard: true,
      });

      // Wait briefly so user can see the code was copied before browser opens
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Open the verification URL in the browser (with validation)
      openGitHubVerificationUrl(status.verificationUri);

      // Wait for user to complete auth
      const result = await waitForAuth();

      // Update store with user and clear auth flow state
      store.getState().setUser(result.user);
      store.getState().setDeviceCode(null);
      store.getState().setIsAuthenticating(false);

      setAuthState(result);
      updateTrayMenu();

      // Save auth to config
      const currentConfig = loadConfig();
      currentConfig.auth = result;
      saveConfig(currentConfig);

      return { success: true, user: result.user };
    } catch (error) {
      // Clear device code and auth state on error
      store.getState().setDeviceCode(null);
      store.getState().setIsAuthenticating(false);

      const { userMessage, technicalDetails } = toUserError(error, 'Authentication');
      logger?.error(technicalDetails);
      return { success: false, error: userMessage };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GITHUB_AUTH_CANCEL, () => {
    const githubAuth = getGitHubAuth();
    githubAuth?.abortPolling();
    // Clear device code and auth state when cancelled
    store.getState().setDeviceCode(null);
    store.getState().setIsAuthenticating(false);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.GITHUB_AUTH_STATUS, () => {
    const authState = getAuthState();
    // Update store so zubridge syncs to renderer
    if (authState?.user) {
      store.getState().setUser(authState.user);
    }
    return {
      isAuthenticated: !!authState,
      user: authState?.user,
    };
  });

  ipcMain.handle(IPC_CHANNELS.GITHUB_AUTH_LOGOUT, () => {
    // Clear user from store
    store.getState().logout();
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
      // Update store so zubridge syncs to renderer
      store.getState().setRepos(repos);
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
      // Update store so zubridge syncs to renderer
      store.getState().setOrgs(orgs);
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
