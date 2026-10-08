/**
 * The providers must survive the window before main has answered.
 *
 * zubridge's renderer store starts as `{}` and is filled only when the first
 * IPC round trip completes. Until then every provider is already on its
 * store branch (the readiness check is a null check that `{}` passes), so a
 * selector that answers a missing slice with a fresh literal hands
 * useSyncExternalStore a new snapshot on every read. React treats that as a
 * change, re-renders synchronously, and repeats until it throws "Maximum
 * update depth exceeded" (minified #185); the ErrorBoundary then replaces the
 * whole app. In the e2e suite that is a launch whose titlebar never appears -
 * only when main is slow enough to lose the race, which is why it was
 * intermittent.
 *
 * The shared zubridge mock cannot show this: it has neither the `{}` initial
 * state nor the useSyncExternalStore path. This file uses the real module.
 */
jest.mock('@zubridge/electron', () =>
  jest.requireActual('../../../node_modules/@zubridge/electron/dist/renderer.cjs')
);

import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { mockLocalmost } from '../../../test/setup-renderer';

type StateListener = (state: unknown) => void;

// The handlers the preload would expose. main never answers getState, so the
// store stays `{}` until a push arrives through subscribe - exactly the
// window this test is about.
let pushState: StateListener | null = null;
const handlers = {
  getState: () => new Promise<unknown>(() => undefined),
  subscribe: (listener: StateListener) => {
    pushState = listener;
    return () => { pushState = null; };
  },
  dispatch: jest.fn(),
};

async function loadProviders() {
  // The store hook is created when the store module loads, and it calls
  // getState at once, so the handlers must be in place first.
  (window as unknown as { zubridge: unknown }).zubridge = handlers;
  const [appConfig, runner, update] = await Promise.all([
    import('./AppConfigContext'),
    import('./RunnerContext'),
    import('./UpdateContext'),
  ]);
  return { ...appConfig, ...runner, ...update };
}

describe('store hydration', () => {
  let consoleErrors: string[];
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrors = [];
    errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });

    // Everything the three providers ask main for on mount.
    mockLocalmost.github.getAuthStatus.mockResolvedValue({ isAuthenticated: false });
    mockLocalmost.github.getRepos.mockResolvedValue({ success: true, repos: [] });
    mockLocalmost.github.getOrgs.mockResolvedValue({ success: true, orgs: [] });
    mockLocalmost.github.onDeviceCode.mockReturnValue(() => {});
    mockLocalmost.runner.isDownloaded.mockResolvedValue(false);
    mockLocalmost.runner.isConfigured.mockResolvedValue(false);
    mockLocalmost.runner.getStatus.mockResolvedValue({ status: 'offline' });
    mockLocalmost.runner.getVersion.mockResolvedValue({ version: null, url: null });
    mockLocalmost.runner.getAvailableVersions.mockResolvedValue({ success: true, versions: [] });
    mockLocalmost.runner.getDisplayName.mockResolvedValue('');
    mockLocalmost.runner.onStatusUpdate.mockReturnValue(() => {});
    mockLocalmost.runner.onDownloadProgress.mockReturnValue(() => {});
    mockLocalmost.settings.get.mockResolvedValue({});
    mockLocalmost.settings.set.mockResolvedValue({ success: true });
    mockLocalmost.jobs.getHistory.mockResolvedValue([]);
    mockLocalmost.jobs.onHistoryUpdate.mockReturnValue(() => {});
    mockLocalmost.jobs.setMaxHistory.mockResolvedValue(undefined);
    mockLocalmost.logs.onEntry.mockReturnValue(() => {});
    mockLocalmost.network.isOnline.mockResolvedValue(true);
    mockLocalmost.update.getStatus.mockResolvedValue({ status: 'idle', currentVersion: '1.0.0' });
    mockLocalmost.update.onStatusChange.mockReturnValue(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('renders the providers on the empty store without a render loop', async () => {
    const { AppConfigProvider, RunnerProvider, UpdateProvider, useAppConfig, useRunner } = await loadProviders();
    const Probe: React.FC = () => {
      const { theme } = useAppConfig();
      const { runnerState, repos } = useRunner();
      return <div data-testid="probe">{`${theme}|${runnerState.status}|${repos.length}`}</div>;
    };

    expect(() =>
      render(
        <AppConfigProvider>
          <RunnerProvider>
            <UpdateProvider>
              <Probe />
            </UpdateProvider>
          </RunnerProvider>
        </AppConfigProvider>
      )
    ).not.toThrow();

    expect(screen.getByTestId('probe')).toHaveTextContent('auto|offline|0');
    // The development build names the defect before it throws.
    expect(consoleErrors.filter((m) => /getSnapshot should be cached|Maximum update depth/.test(m))).toEqual([]);
  });

  it('switches to the main state when it arrives after the first render', async () => {
    const { AppConfigProvider, RunnerProvider, UpdateProvider, useAppConfig, useRunner } = await loadProviders();
    const Probe: React.FC = () => {
      const { theme } = useAppConfig();
      const { runnerState, repos } = useRunner();
      return <div data-testid="probe">{`${theme}|${runnerState.status}|${repos.length}`}</div>;
    };

    render(
      <AppConfigProvider>
        <RunnerProvider>
          <UpdateProvider>
            <Probe />
          </UpdateProvider>
        </RunnerProvider>
      </AppConfigProvider>
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('auto|offline|0');
    expect(pushState).not.toBeNull();

    act(() => {
      pushState!({
        config: { theme: 'dark' },
        runner: { runnerState: { status: 'listening' } },
        github: { repos: [{ id: 1, name: 'repo', full_name: 'me/repo', private: false, html_url: '' }] },
      });
    });

    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('dark|listening|1'));
    expect(consoleErrors.filter((m) => /getSnapshot should be cached|Maximum update depth/.test(m))).toEqual([]);
  });
});
