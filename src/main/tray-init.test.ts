import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Menu, Tray, nativeImage } from 'electron';
import { TrayManager } from './tray';

type Auth = { user: { login: string }; accessToken?: string; expired?: boolean } | null;
let authState: Auth = null;
let trayManager: TrayManager | null = null;
let pauseState: { isPaused: boolean; reason: string | null } = { isPaused: false, reason: null };
let resourceOverridden: string | null = null;
jest.mock('./app-state', () => ({
  getMainWindow: () => null,
  getTrayManager: () => trayManager,
  setTrayManager: jest.fn(),
  getRunnerManager: () => ({ getStatus: () => ({ status: 'listening' }), isConfigured: () => true }),
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

  it('shows a resource pause a resume overrode, until its condition clears', () => {
    authState = { user: { login: 'bfulton' }, accessToken: 'tok' };
    resourceOverridden = 'Battery at 20%';

    updateTrayMenu();

    expect(menuLabels()).toEqual(expect.arrayContaining([
      'Runner: Listening',
      'Resumed (resource pause overridden until Battery at 20% clears)',
      '⏸  Pause',
    ]));

    // Another condition that begins pauses the runner, and the pause is
    // what the tray shows.
    pauseState = { isPaused: true, reason: 'Video call detected' };
    updateTrayMenu();

    const labels = menuLabels();
    expect(labels[0]).toBe('⏸ Video call detected');
    expect(labels).not.toContain('Resumed (resource pause overridden until Battery at 20% clears)');
  });
});
