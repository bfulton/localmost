import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockHandle = jest.fn<(channel: string, handler: (...args: any[]) => any) => void>();
jest.mock('electron', () => ({ ipcMain: { handle: mockHandle } }));
// The sender check has tests of its own (trusted-ipc.test.ts); here the
// handlers are called directly, so they are registered on electron's ipcMain.
jest.mock('./trusted-ipc', () => ({ ipcMain: jest.requireMock<{ ipcMain: unknown }>('electron').ipcMain }));

const mockGitHubAuth = {
  getRunnerRegistrationToken: jest.fn<(...args: unknown[]) => Promise<string>>(),
  getOrgRunnerRegistrationToken: jest.fn<(...args: unknown[]) => Promise<string>>(),
  listRunners: jest.fn<(...args: unknown[]) => Promise<unknown[]>>(),
  listOrgRunners: jest.fn<(...args: unknown[]) => Promise<unknown[]>>(),
  cancelWorkflowRun: jest.fn<(...args: unknown[]) => Promise<void>>(),
};
jest.mock('../app-state', () => ({
  getMainWindow: () => null,
  getGitHubAuth: () => mockGitHubAuth,
  getRunnerManager: () => null,
  getRunnerDownloader: () => null,
  getHeartbeatManager: () => null,
  getAuthState: () => null,
  getLogger: () => null,
  getIsQuitting: () => false,
  getBrokerProxyService: () => null,
  getRunnerState: () => null,
}));
jest.mock('../auth-tokens', () => ({
  getValidAccessToken: () => Promise.resolve('tok'),
  forceRefreshToken: jest.fn(),
}));
jest.mock('../user-error', () => ({
  toUserError: (error: Error) => ({ userMessage: error.message, technicalDetails: error.message }),
}));
jest.mock('../config', () => ({ loadConfig: () => ({}) }));
jest.mock('../runner-lifecycle', () => ({ clearStaleRunnerRegistrations: jest.fn() }));
jest.mock('../runner-proxy-manager', () => ({ getRunnerProxyManager: jest.fn() }));
jest.mock('../runner-state-service', () => ({ sendRunnerEvent: jest.fn() }));
jest.mock('../tray-init', () => ({ updateTrayMenu: jest.fn() }));
jest.mock('../store', () => ({ store: { getState: () => ({}) } }));

import { registerRunnerHandlers } from './runner';
import { IPC_CHANNELS } from '../../shared/types';

describe('runner IPC handlers', () => {
  let handlers: Record<string, (...args: any[]) => any>;

  beforeEach(() => {
    jest.clearAllMocks();
    handlers = {};
    mockHandle.mockImplementation((channel, handler) => {
      handlers[channel] = handler;
    });
    registerRunnerHandlers();
  });

  describe('configure', () => {
    it('refuses an owner, repo or org that is not a GitHub name, before any token is requested', async () => {
      for (const options of [
        { level: 'repo', repoUrl: 'https://github.com/../orgs', runnerName: 'r' },
        { level: 'repo', repoUrl: 'https://github.com/a?b/c', runnerName: 'r' },
        { level: 'org', orgName: 'x/../../user', runnerName: 'r' },
        { level: 'org', orgName: '..', runnerName: 'r' },
      ]) {
        const result = await handlers[IPC_CHANNELS.RUNNER_CONFIGURE]({}, options);
        expect({ options, success: result.success }).toEqual({ options, success: false });
      }
      expect(mockGitHubAuth.getRunnerRegistrationToken).not.toHaveBeenCalled();
      expect(mockGitHubAuth.getOrgRunnerRegistrationToken).not.toHaveBeenCalled();
    });
  });

  describe('job cancel', () => {
    it('cancels a run only in a repository named the way GitHub names one', async () => {
      for (const [owner, repo, runId] of [
        ['..', 'x', 1],
        ['o', '../../orgs/x', 1],
        ['o', 'r', '1/../../x'],
      ]) {
        const result = await handlers[IPC_CHANNELS.JOB_CANCEL]({}, owner, repo, runId);
        expect({ owner, repo, runId, success: result.success }).toEqual({ owner, repo, runId, success: false });
      }
      expect(mockGitHubAuth.cancelWorkflowRun).not.toHaveBeenCalled();

      mockGitHubAuth.cancelWorkflowRun.mockResolvedValue(undefined);
      expect(await handlers[IPC_CHANNELS.JOB_CANCEL]({}, 'o', 'my.repo', 42)).toEqual({ success: true });
      expect(mockGitHubAuth.cancelWorkflowRun).toHaveBeenCalledWith('tok', 'o', 'my.repo', 42);
    });
  });
});
