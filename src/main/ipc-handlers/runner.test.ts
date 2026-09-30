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
const mockRunnerDownloader = {
  setDownloadVersion: jest.fn<(version: string | null) => void>(),
};
const mockRunnerManager = {
  isRunning: () => false,
  setMaxJobHistory: jest.fn<(max: number) => void>(),
};
const mockSetSelectedVersion = jest.fn<(version: string) => void>();
jest.mock('../app-state', () => ({
  getMainWindow: () => null,
  getGitHubAuth: () => mockGitHubAuth,
  getRunnerManager: () => mockRunnerManager,
  getRunnerDownloader: () => mockRunnerDownloader,
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
jest.mock('../store', () => ({ store: { getState: () => ({ setSelectedVersion: mockSetSelectedVersion }) } }));

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
        { level: 'repo', repoUrl: 'https://github.com/../orgs', runnerName: 'r', labels: [] },
        { level: 'repo', repoUrl: 'https://github.com/a?b/c', runnerName: 'r', labels: [] },
        { level: 'org', orgName: 'x/../../user', runnerName: 'r', labels: [] },
        { level: 'org', orgName: '..', runnerName: 'r', labels: [] },
      ]) {
        const result = await handlers[IPC_CHANNELS.RUNNER_CONFIGURE]({}, options);
        expect({ options, success: result.success }).toEqual({ options, success: false });
      }
      expect(mockGitHubAuth.getRunnerRegistrationToken).not.toHaveBeenCalled();
      expect(mockGitHubAuth.getOrgRunnerRegistrationToken).not.toHaveBeenCalled();
    });

    it('registers with the whole repository name, dots and all', async () => {
      // The URL used to be cut at the repo name's first dot, so a runner for
      // o/my.repo asked for - and registered with - o/my's token. Only the
      // token request is of interest here; the rest of configuring is not.
      mockGitHubAuth.getRunnerRegistrationToken.mockRejectedValue(new Error('stop here'));
      for (const repoUrl of [
        'https://github.com/o/my.repo',
        'https://github.com/o/my.repo.git',
        'https://github.com/o/my.repo/',
      ]) {
        mockGitHubAuth.getRunnerRegistrationToken.mockClear();
        await handlers[IPC_CHANNELS.RUNNER_CONFIGURE]({}, { level: 'repo', repoUrl, runnerName: 'r', labels: [] });
        expect({ repoUrl, calls: mockGitHubAuth.getRunnerRegistrationToken.mock.calls }).toEqual({
          repoUrl,
          calls: [['tok', 'o', 'my.repo']],
        });
      }
    });

    it('refuses a URL that only mentions github.com, or is on another host', async () => {
      for (const repoUrl of [
        'https://evil.example/github.com/o/r',
        'https://github.com.evil.example/o/r',
        'git@github.com:o/r.git',
      ]) {
        const result = await handlers[IPC_CHANNELS.RUNNER_CONFIGURE]({}, { level: 'repo', repoUrl, runnerName: 'r', labels: [] });
        expect({ repoUrl, result }).toEqual({ repoUrl, result: { success: false, error: 'Invalid repository URL' } });
      }
      expect(mockGitHubAuth.getRunnerRegistrationToken).not.toHaveBeenCalled();
    });

    it('refuses a runner name, labels or count that are not what configuration takes', async () => {
      const valid = { level: 'repo', repoUrl: 'https://github.com/o/r', runnerName: 'localmost.host', labels: ['self-hosted'] };
      for (const options of [
        null,
        { ...valid, level: 'enterprise' },
        { ...valid, runnerName: '' },
        { ...valid, runnerName: 7 },
        { ...valid, labels: 'self-hosted' },
        { ...valid, labels: [{}] },
        { ...valid, runnerCount: 1e9 },
        { ...valid, runnerCount: 0 },
        { ...valid, runnerCount: 2.5 },
      ]) {
        const result = await handlers[IPC_CHANNELS.RUNNER_CONFIGURE]({}, options);
        expect({ options, success: result.success }).toEqual({ options, success: false });
      }
      expect(mockGitHubAuth.getRunnerRegistrationToken).not.toHaveBeenCalled();
    });
  });

  describe('download version', () => {
    it('takes only a runner version number, which becomes a directory and a URL', async () => {
      // The version is joined into the arc directory the download creates and,
      // on failure, removes recursively; '../' in it would point that anywhere.
      for (const version of ['../x', '2.330.0/../../x', '/../../../Users/me/Documents', '2.330', 'v2.330.0', 7, {}]) {
        const result = await handlers[IPC_CHANNELS.RUNNER_SET_DOWNLOAD_VERSION]({}, version);
        expect({ version, success: result.success }).toEqual({ version, success: false });
      }
      expect(mockRunnerDownloader.setDownloadVersion).not.toHaveBeenCalled();
      expect(mockSetSelectedVersion).not.toHaveBeenCalled();

      expect(await handlers[IPC_CHANNELS.RUNNER_SET_DOWNLOAD_VERSION]({}, '2.330.0')).toEqual({ success: true });
      expect(mockRunnerDownloader.setDownloadVersion).toHaveBeenCalledWith('2.330.0');
      expect(await handlers[IPC_CHANNELS.RUNNER_SET_DOWNLOAD_VERSION]({}, null)).toEqual({ success: true });
      expect(mockRunnerDownloader.setDownloadVersion).toHaveBeenLastCalledWith(null);
    });
  });

  describe('job history size', () => {
    it('takes only a whole number of jobs within the offered range', async () => {
      for (const max of [1e9, -1, 2.5, '10', null]) {
        const result = await handlers[IPC_CHANNELS.JOB_HISTORY_SET_MAX]({}, max);
        expect({ max, success: result.success }).toEqual({ max, success: false });
      }
      expect(mockRunnerManager.setMaxJobHistory).not.toHaveBeenCalled();

      expect(await handlers[IPC_CHANNELS.JOB_HISTORY_SET_MAX]({}, 20)).toEqual({ success: true });
      expect(mockRunnerManager.setMaxJobHistory).toHaveBeenCalledWith(20);
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

    it("cancels a run whose owner is an older login, as GitHub's job record names it", async () => {
      // The owner comes from the job GitHub ran, not from anything typed, and
      // GitHub once issued logins with a trailing or doubled hyphen.
      mockGitHubAuth.cancelWorkflowRun.mockResolvedValue(undefined);
      for (const owner of ['o-', 'old--name', 'emu_user']) {
        expect(await handlers[IPC_CHANNELS.JOB_CANCEL]({}, owner, 'r', 42)).toEqual({ success: true });
        expect(mockGitHubAuth.cancelWorkflowRun).toHaveBeenLastCalledWith('tok', owner, 'r', 42);
      }
    });

    it('still refuses an owner that could carry a path, a query or a dot segment', async () => {
      for (const owner of ['o/../orgs', 'o/x', 'o?x', '.', 'o.x', '', 42]) {
        const result = await handlers[IPC_CHANNELS.JOB_CANCEL]({}, owner, 'r', 42);
        expect({ owner, success: result.success }).toEqual({ owner, success: false });
      }
      expect(mockGitHubAuth.cancelWorkflowRun).not.toHaveBeenCalled();
    });
  });
});
