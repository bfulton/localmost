import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Target } from '../shared/types';

const mockLoadConfig = jest.fn<() => unknown>();
jest.mock('./config', () => ({ loadConfig: mockLoadConfig }));

const mockGetValidAccessToken = jest.fn<() => Promise<string | null>>();
jest.mock('./auth-tokens', () => ({
  getValidAccessToken: mockGetValidAccessToken,
  cancelJobsOnOurRunners: jest.fn(),
}));

jest.mock('./app-state', () => ({
  getGitHubAuth: jest.fn(() => ({
    listRunners: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    listOrgRunners: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
  })),
  getRunnerDownloader: jest.fn(),
  getRunnerManager: jest.fn(),
  getLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
  getBusyInstances: jest.fn(() => new Set()),
  getReregisteringInstances: jest.fn(() => new Set()),
}));

const mockReplaceExposedKeys = jest.fn<(target: Target) => Promise<void>>();
jest.mock('./runner-proxy-manager', () => ({
  getRunnerProxyManager: () => ({
    replaceExposedKeys: mockReplaceExposedKeys,
    registerAll: jest.fn(),
  }),
}));

import { getGitHubAuth, getRunnerDownloader, getRunnerManager } from './app-state';
import { clearStaleRunnerRegistrations, reRegisterSingleInstance, reRegisterRunner1 } from './runner-lifecycle';

const target = (id: string, enabled: boolean): Target => ({
  id,
  type: 'repo',
  owner: 'owner',
  repo: id,
  displayName: `owner/${id}`,
  url: `https://github.com/owner/${id}`,
  proxyRunnerName: `localmost.host.owner-${id}`,
  enabled,
  addedAt: '2026-01-01T00:00:00.000Z',
});

describe('clearStaleRunnerRegistrations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetValidAccessToken.mockResolvedValue('user-token');
    mockReplaceExposedKeys.mockResolvedValue(undefined);
  });

  it("replaces every target's exposed registration keys before the broker opens sessions with them", async () => {
    // Runs on every start, ahead of the broker loading credentials. A
    // disabled target's key works for whoever took it all the same, and the
    // proxy-only setup has no worker runner name, which ends the rest early.
    const targets = [target('a', true), target('b', false)];
    mockLoadConfig.mockReturnValue({ targets });

    await clearStaleRunnerRegistrations();

    expect(mockReplaceExposedKeys.mock.calls).toEqual([[targets[0]], [targets[1]]]);
  });

  it('replaces nothing while signed out, since registering needs the user', async () => {
    mockGetValidAccessToken.mockResolvedValue(null);
    mockLoadConfig.mockReturnValue({ targets: [target('a', true)] });

    await clearStaleRunnerRegistrations();

    expect(mockReplaceExposedKeys).not.toHaveBeenCalled();
  });
});

describe('reRegisterSingleInstance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetValidAccessToken.mockResolvedValue('user-token');
  });

  it('re-registers the slot without starting a worker in it that no job was spawned for', async () => {
    // Only the worker spawned for a job may take it. One started here has no
    // job, never gets one, and held the slot - and with one runner, every
    // job - until the app restarted. The next job's spawn starts the slot.
    mockLoadConfig.mockReturnValue({
      runnerConfig: { runnerName: 'host', labels: 'self-hosted' },
      targets: [target('a', true)],
    });
    const getRunnerRegistrationToken = jest.fn<() => Promise<string>>().mockResolvedValue('reg-token');
    jest.mocked(getGitHubAuth).mockReturnValue({ getRunnerRegistrationToken } as never);
    const downloader = {
      clearConfig: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      configureInstance: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getInstalledVersion: jest.fn(() => '2.330.0'),
    };
    jest.mocked(getRunnerDownloader).mockReturnValue(downloader as never);
    const manager = {
      stopInstance: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      startInstance: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    jest.mocked(getRunnerManager).mockReturnValue(manager as never);

    await reRegisterSingleInstance(1, 'registration_deleted');

    expect(manager.stopInstance).toHaveBeenCalledWith(1);
    expect(downloader.configureInstance).toHaveBeenCalledWith(1, '2.330.0', expect.objectContaining({
      url: 'https://github.com/owner/a', token: 'reg-token', name: 'host.1',
    }));
    expect(manager.startInstance).not.toHaveBeenCalled();
  });
});

describe('a runner saved before targets, by its repository URL', () => {
  // Configs from before the targets list name the repository only as
  // runnerConfig.repoUrl: GitHub's html_url for it, as the setup wizard saved it.
  const register = () => {
    const getRunnerRegistrationToken = jest.fn<() => Promise<string>>().mockResolvedValue('reg-token');
    jest.mocked(getGitHubAuth).mockReturnValue({ getRunnerRegistrationToken } as never);
    const downloader = {
      clearConfig: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      configureInstance: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getInstalledVersion: jest.fn(() => '2.330.0'),
    };
    jest.mocked(getRunnerDownloader).mockReturnValue(downloader as never);
    jest.mocked(getRunnerManager).mockReturnValue({
      stopInstance: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as never);
    return { getRunnerRegistrationToken, downloader };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetValidAccessToken.mockResolvedValue('user-token');
  });

  const saved = [
    'https://github.com/o/my.repo',
    'https://github.com/o/my.repo.git',
    'https://github.com/o/my.repo/',
  ];

  it('re-registers a slot with the whole repository name, dots and all', async () => {
    // The name used to be cut at its first dot: o/my.repo re-registered with
    // o/my, a repository the user may not have, or may not mean.
    for (const repoUrl of saved) {
      mockLoadConfig.mockReturnValue({ runnerConfig: { level: 'repo', runnerName: 'host', repoUrl } });
      const { getRunnerRegistrationToken, downloader } = register();

      await reRegisterSingleInstance(1, 'registration_deleted');

      expect({ repoUrl, calls: getRunnerRegistrationToken.mock.calls }).toEqual({
        repoUrl,
        calls: [['user-token', 'o', 'my.repo']],
      });
      expect(downloader.configureInstance).toHaveBeenCalledWith(1, '2.330.0', expect.objectContaining({
        url: 'https://github.com/o/my.repo',
      }));
    }
  });

  it('re-registers the first runner with the whole repository name', async () => {
    for (const repoUrl of saved) {
      const { getRunnerRegistrationToken, downloader } = register();

      await reRegisterRunner1({ level: 'repo', runnerName: 'host', repoUrl, runnerCount: 1 }, 'user-token');

      expect({ repoUrl, calls: getRunnerRegistrationToken.mock.calls }).toEqual({
        repoUrl,
        calls: [['user-token', 'o', 'my.repo']],
      });
      expect(downloader.configureInstance).toHaveBeenCalledWith(1, '2.330.0', expect.objectContaining({
        url: 'https://github.com/o/my.repo',
      }));
    }
  });

  it('re-registers a repository whose owner is a login only older accounts can have', async () => {
    // GitHub once issued logins with a trailing or doubled hyphen, and the
    // wizard saved such an owner's html_url as it was. The old pattern let
    // any owner through here, so holding it to the rule for new logins
    // would leave these runners registered nowhere.
    const repoUrl = 'https://github.com/old-name-/r';
    mockLoadConfig.mockReturnValue({ runnerConfig: { level: 'repo', runnerName: 'host', repoUrl } });
    const single = register();
    await reRegisterSingleInstance(1, 'registration_deleted');
    expect(single.getRunnerRegistrationToken.mock.calls).toEqual([['user-token', 'old-name-', 'r']]);

    const first = register();
    await reRegisterRunner1({ level: 'repo', runnerName: 'host', repoUrl, runnerCount: 1 }, 'user-token');
    expect(first.getRunnerRegistrationToken.mock.calls).toEqual([['user-token', 'old-name-', 'r']]);
    expect(first.downloader.configureInstance).toHaveBeenCalledWith(1, '2.330.0', expect.objectContaining({
      url: 'https://github.com/old-name-/r',
    }));
  });

  it('registers nowhere for a URL that only mentions github.com, or is on another host', async () => {
    for (const repoUrl of ['https://evil.example/github.com/o/r', 'https://github.com.evil.example/o/r']) {
      mockLoadConfig.mockReturnValue({ runnerConfig: { level: 'repo', runnerName: 'host', repoUrl } });
      const { getRunnerRegistrationToken } = register();

      await reRegisterSingleInstance(1, 'registration_deleted');
      await expect(reRegisterRunner1({ level: 'repo', runnerName: 'host', repoUrl, runnerCount: 1 }, 'user-token'))
        .rejects.toThrow('No registration target configured');

      expect({ repoUrl, calls: getRunnerRegistrationToken.mock.calls }).toEqual({ repoUrl, calls: [] });
    }
  });
});
