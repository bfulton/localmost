/**
 * What a renderer can write to the main store through the bridge.
 *
 * Drives the real zubridge main-side handlers through a stand-in ipcMain, the
 * way a renderer's dispatch arrives: the store persists to disk, and the
 * target manager reads targets back from there.
 */

import { jest, describe, it, expect, afterAll } from '@jest/globals';

type Listener = (event: unknown, payload: unknown) => unknown;
const onListeners: Record<string, Listener> = {};
jest.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: Listener) => {
      onListeners[channel] = listener;
    },
    handle: jest.fn(),
    removeHandler: jest.fn(),
    removeListener: jest.fn(),
    removeAllListeners: jest.fn(),
  },
  webContents: { fromId: () => undefined, getAllWebContents: () => [] },
  app: { on: jest.fn(), getName: () => 'localmost' },
}));

// uuid ships ESM only, which this jest setup does not transform; zubridge
// uses it for thunk ids alone.
let mockNextId = 0;
jest.mock('uuid', () => ({ v4: () => `id-${++mockNextId}` }));

const mockBootLog = jest.fn();
jest.mock('../log-file', () => ({
  ...jest.requireActual<Record<string, unknown>>('../log-file'),
  bootLog: (...args: unknown[]) => mockBootLog(...args),
}));

import { store } from './index';
import { initBridge, destroyBridge, getBridge } from './bridge';

const sender = { id: 1, isDestroyed: () => false, send: jest.fn(), once: jest.fn(), on: jest.fn() };
const window = { id: 1, webContents: sender, isDestroyed: () => false, on: jest.fn(), once: jest.fn() };

const dispatchFromRenderer = async (action: Record<string, unknown>): Promise<void> => {
  await onListeners['zubridge:dispatch']({ sender }, { action: { __id: `a${Math.random()}`, ...action } });
  await new Promise((resolve) => setTimeout(resolve, 50));
};

describe('the renderer side of the store bridge', () => {
  afterAll(async () => {
    // The bridge's periodic cleanup timer outlives destroyBridge(); only the
    // bridge's own destroy clears it.
    await getBridge()?.destroy();
    destroyBridge();
  });

  it('sends every renderer action to the reducer that ignores it, and says so once', async () => {
    initBridge(window as never);
    // A name Object.prototype carries must not resolve to one of its methods.
    await dispatchFromRenderer({ type: 'constructor', payload: {} });
    for (let i = 0; i < 5; i++) await dispatchFromRenderer({ type: 'setTheme', payload: 'dark' });

    // A renderer dispatching in a loop must not fill the boot log.
    const warnings = mockBootLog.mock.calls.filter(([level]) => level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0][1]).toContain('"constructor"');
  });

  it('cannot write the store: not by action, not by a raw setState', async () => {
    initBridge(window as never);
    const before = store.getState().config;
    const planted = [{ id: 'x', type: 'repo', owner: '../x', repo: 'y', displayName: 'x', url: 'https://evil.example' }];

    await dispatchFromRenderer({ type: 'setTargets', payload: planted });
    await dispatchFromRenderer({ type: 'setUserFilter', payload: { scope: 'everyone', allowedUsers: 'just-me', allowlist: [] } });
    await dispatchFromRenderer({ type: 'setState', payload: { config: { ...before, targets: planted } } });
    await dispatchFromRenderer({ type: 'config.setTargets', payload: planted });

    expect(store.getState().config).toBe(before);
  });
});
