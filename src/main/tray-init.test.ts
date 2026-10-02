import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Menu, Tray, nativeImage } from 'electron';
import { TrayManager } from './tray';

type Auth = { user: { login: string }; accessToken?: string; expired?: boolean } | null;
let authState: Auth = null;
let trayManager: TrayManager | null = null;
let pauseState: { isPaused: boolean; reason: string | null } = { isPaused: false, reason: null };
let resourceOverridden: string | null = null;
let runnerStatus = 'listening';
let machineStarted = true;
jest.mock('./app-state', () => ({
  getMainWindow: () => null,
  getTrayManager: () => trayManager,
  setTrayManager: jest.fn(),
  getRunnerManager: () => ({ getStatus: () => ({ status: runnerStatus }), isConfigured: () => true }),
  getAuthState: () => authState,
  getPowerSaveBlockerId: () => null,
  getBrokerProxyService: () => null,
  getEffectivePauseState: () => pauseState,
  getResourceMonitor: () => ({
    getPauseState: () => ({ isPaused: false, reason: null, conditions: [], overridden: resourceOverridden }),
  }),
  getLogger: () => undefined,
}));
jest.mock('./log-file', () => ({ findAsset: jest.fn() }));
jest.mock('./window', () => ({ confirmQuitIfBusy: jest.fn() }));
jest.mock('./runner-pause', () => ({ pauseRunner: jest.fn(), resumeRunner: jest.fn() }));
jest.mock('./runner-state-service', () => ({ isRunning: () => machineStarted, isStarting: () => false }));

import { updateTrayMenu } from './tray-init';

/** The labels of the menu the tray was last given. */
const menuLabels = (): string[] => {
  const calls = jest.mocked(Menu.buildFromTemplate).mock.calls;
  const template = calls[calls.length - 1][0] as Electron.MenuItemConstructorOptions[];
  return template.map((item) => item.label ?? item.type ?? '');
};

describe('updateTrayMenu', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pauseState = { isPaused: false, reason: null };
    resourceOverridden = null;
    runnerStatus = 'listening';
    machineStarted = true;
    // The tray's own icon; the animation frames are absent, which it allows.
    jest.mocked(nativeImage.createFromPath).mockReturnValue({ setTemplateImage: jest.fn() } as never);
    jest.mocked(Tray).mockImplementation(() => ({
      setContextMenu: jest.fn(),
      setToolTip: jest.fn(),
      setImage: jest.fn(),
    }) as never);
    trayManager = new TrayManager(
      {
        onShowStatus: jest.fn(),
        onShowSettings: jest.fn(),
        onShowWindow: jest.fn(),
        onHideWindow: jest.fn(),
        onPause: jest.fn<() => void>(),
        onResume: jest.fn<() => void>(),
        onQuit: jest.fn<() => Promise<void>>(),
      },
      (name) => (name === 'tray-iconTemplate.png' ? '/assets/tray-iconTemplate.png' : undefined)
    );
    trayManager.create();
  });

  it('shows no session as not connected, and offers no Pause', () => {
    authState = null;

    updateTrayMenu();

    const labels = menuLabels();
    expect(labels[0]).toBe('GitHub: Not connected');
    expect(labels).not.toContain('⏸  Pause');
    expect(labels).not.toContain('▶  Resume');
  });

  it('shows a live session as connected, with Pause', () => {
    authState = { user: { login: 'bfulton' }, accessToken: 'tok' };

    updateTrayMenu();

    expect(menuLabels()).toEqual(expect.arrayContaining(['Runner: Listening', '⏸  Pause']));
  });

  it('shows an expired session as needing sign-in again, and offers no Pause', () => {
    // The auth state outlives the session: it keeps the login so the app can
    // offer to reconnect as the right person. The tray read any auth state as
    // connected, so a spent session still said the runner was listening and
    // offered Pause, for a runner that could no longer get a token.
    authState = { user: { login: 'bfulton' }, expired: true };

    updateTrayMenu();

    const labels = menuLabels();
    expect(labels[0]).toBe('GitHub: Session expired, reconnect in Settings');
    expect(labels).not.toContain('⏸  Pause');
    expect(labels).not.toContain('▶  Resume');
  });

  it('shows a resource pause in place of the status of a started runner, with Resume', () => {
    authState = { user: { login: 'bfulton' }, accessToken: 'tok' };
    pauseState = { isPaused: true, reason: 'Battery at 20%' };

    updateTrayMenu();

    const labels = menuLabels();
    expect(labels[0]).toBe('⏸ Battery at 20%');
    expect(labels).toContain('▶  Resume');
  });

  it('shows a failed start as an error with its resource pause beside it, and offers no Resume', () => {
    // The monitor's pause is recorded in any state, and the tray read it
    // first: a start that failed on battery showed "Battery at 20%" and
    // offered a Resume that answered "not started" and did nothing.
    authState = { user: { login: 'bfulton' }, accessToken: 'tok' };
    pauseState = { isPaused: true, reason: 'Battery at 20%' };
    runnerStatus = 'error';
    machineStarted = false;

    updateTrayMenu();

    const labels = menuLabels();
    expect(labels[0]).toBe('Runner: Error');
    expect(labels[1]).toBe('⏸ Battery at 20%');
    expect(labels).not.toContain('▶  Resume');
    expect(labels).not.toContain('⏸  Pause');
  });

  it('shows a resource pause a resume overrode, until its condition clears', () => {
    authState = { user: { login: 'bfulton' }, accessToken: 'tok' };
    resourceOverridden = 'battery power';

    updateTrayMenu();

    expect(menuLabels()).toEqual(expect.arrayContaining([
      'Runner: Listening',
      'Resumed (resource pause overridden until battery power clears)',
      '⏸  Pause',
    ]));

    // Another condition that begins pauses the runner, and the pause is
    // what the tray shows.
    pauseState = { isPaused: true, reason: 'Video call detected' };
    updateTrayMenu();

    const labels = menuLabels();
    expect(labels[0]).toBe('⏸ Video call detected');
    expect(labels).not.toContain('Resumed (resource pause overridden until battery power clears)');
  });
});
