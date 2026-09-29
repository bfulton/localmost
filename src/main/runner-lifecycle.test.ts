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

import { clearStaleRunnerRegistrations } from './runner-lifecycle';

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
