import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockLoadConfig = jest.fn<() => Record<string, unknown>>();
const mockSaveConfig = jest.fn<(c: unknown) => void>();
jest.mock('./config', () => ({
  loadConfig: () => mockLoadConfig(),
  saveConfig: (c: unknown) => mockSaveConfig(c),
}));

type Auth = { refreshToken?: string; user: { login: string }; expired?: boolean } | null;
let authState: Auth = null;
const mockRefresh = jest.fn<(t: string) => Promise<unknown>>();
jest.mock('./app-state', () => ({
  getAuthState: () => authState,
  setAuthState: (s: Auth) => { authState = s; },
  getGitHubAuth: () => ({ refreshAccessToken: (t: string) => mockRefresh(t) }),
  getLogger: () => undefined,
}));

import { forceRefreshToken } from './auth-tokens';

describe('a refresh that can never succeed', () => {
  beforeEach(() => {
    authState = { refreshToken: 'spent-token', user: { login: 'bfulton' } };
    mockLoadConfig.mockReturnValue({});
    mockSaveConfig.mockReset();
    mockRefresh.mockReset();
  });

  it('marks the session expired, so the app stops claiming to be signed in', async () => {
    // GitHub answers a spent or revoked refresh token with a message about the
    // client id and secret, which is misleading but definitive: the code
    // already classifies it as non-retryable. It just kept the auth state, so
    // Settings showed the account with a Sign Out button, the CLI said
    // "Connected as @bfulton", and heartbeats retried a dead token 7763 times
    // while jobs were refused for "not authenticated".
    mockRefresh.mockRejectedValue(
      new Error('Failed to refresh token: The client_id and/or client_secret passed are incorrect.')
    );

    expect(await forceRefreshToken()).toBeNull();

    expect(authState?.expired).toBe(true);
    // The login survives, so the UI can say who to reconnect as.
    expect(authState?.user.login).toBe('bfulton');
    // And it is persisted, or a restart would forget and claim health again.
    expect(mockSaveConfig).toHaveBeenCalled();
  });

  it('leaves a network blip alone, since that session is not expired', async () => {
    mockRefresh.mockRejectedValue(new Error('network timeout: ETIMEDOUT'));

    expect(await forceRefreshToken()).toBeNull();

    expect(authState?.expired).toBeUndefined();
    // Longer than jest's default: this exercises the real backoff, 1s + 2s +
    // 4s, rather than pretending the retries are free.
  }, 15000);

  it('clears the flag when a refresh works again', async () => {
    authState = { refreshToken: 'spent-token', user: { login: 'bfulton' }, expired: true };
    mockRefresh.mockResolvedValue({
      accessToken: 'fresh', refreshToken: 'next', expiresAt: 1, user: { login: 'bfulton' },
    });

    expect(await forceRefreshToken()).toBe('fresh');
    expect(authState?.expired).toBeFalsy();
  });
});
