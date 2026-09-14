/**
 * Seed the zubridge store the way the running app has it.
 *
 * Every value the runner context exposes is read as
 * `isZubridgeReady ? store : fallback`. In the app the store is always
 * populated, so production always takes the store branch. In tests the mock
 * state defaults to null, so `isZubridgeReady` is false and every test takes
 * the fallback branch instead - the branch the app never uses.
 *
 * That is why three defects in the expired-session work shipped green: the
 * suite could not reach the code the app runs. Tests that care about real
 * behaviour should call this.
 */
import { __setMockState, __resetMockState } from './__mocks__/@zubridge/electron';

export interface ZubridgeSeed {
  user?: { login: string; name?: string; avatar_url?: string } | null;
  isAuthenticating?: boolean;
  deviceCode?: { userCode: string; verificationUri: string } | null;
  isDownloaded?: boolean;
  isConfigured?: boolean;
}

/** Put the store in the shape a running app has, with the given overrides. */
export function seedZubridge(seed: ZubridgeSeed = {}): void {
  __setMockState({
    config: {},
    auth: {
      user: seed.user === undefined ? null : seed.user,
      isAuthenticating: seed.isAuthenticating ?? false,
      deviceCode: seed.deviceCode ?? null,
    },
    runner: {
      isDownloaded: seed.isDownloaded ?? true,
      isConfigured: seed.isConfigured ?? true,
      runnerVersion: { version: 'v2.336.0', url: null },
      availableVersions: [],
      selectedVersion: 'v2.336.0',
      downloadProgress: null,
      isLoadingVersions: false,
      runnerDisplayName: 'localmost.test',
      runnerState: { status: 'listening' },
      targets: [],
      targetStatus: [],
    },
    jobs: { history: [] },
    github: { repos: [], orgs: [] },
    update: {},
    ui: { isLoading: false, isInitialLoading: false, error: null },
  });
}

export function resetZubridge(): void {
  __resetMockState();
}
