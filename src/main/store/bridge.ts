/**
 * Zubridge integration - syncs Zustand store to renderer processes.
 */

import { BrowserWindow } from 'electron';
import { createZustandBridge } from '@zubridge/electron/main';
import { store } from './index';
import { bootLog } from '../log-file';

// Bridge instance
let bridge: ReturnType<typeof createZustandBridge> | null = null;
let unsubscribe: (() => void) | null = null;
// Said once: a renderer dispatching in a loop would otherwise fill the boot log.
let warnedRendererAction = false;

/**
 * Initialize the zubridge for a window.
 * Call this after creating the main window.
 */
export function initBridge(mainWindow: BrowserWindow): void {
  if (bridge) {
    // Already initialized, just subscribe the new window
    const sub = bridge.subscribe([mainWindow]);
    // Store the unsubscribe function
    if (unsubscribe) {
      const oldUnsub = unsubscribe;
      unsubscribe = () => {
        oldUnsub();
        sub.unsubscribe();
      };
    } else {
      unsubscribe = sub.unsubscribe;
    }
    return;
  }

  // Create the bridge. The renderer reads this store and never writes it:
  // every change goes through an IPC handler that checks it first. By
  // default zubridge lets a renderer dispatch call any store action by name,
  // or replace state outright with a "setState" action, and the store is
  // persisted - so a renderer running someone else's script could plant
  // targets or widen the user filter on disk. An empty handler table sends
  // every renderer action to this reducer instead, which changes nothing.
  // The table has no prototype: zubridge looks a handler up with `in`, which
  // would otherwise find "constructor" and the rest of Object.prototype.
  bridge = createZustandBridge(store, {
    handlers: Object.create(null) as Record<string, never>,
    reducer: (state: ReturnType<typeof store.getState>, action: { type: string }) => {
      if (!warnedRendererAction) {
        warnedRendererAction = true;
        bootLog('warn', `Ignored store action "${action.type}" from a renderer; the renderer cannot write the store`);
      }
      return state;
    },
  });

  // Subscribe the window
  const sub = bridge.subscribe([mainWindow]);
  unsubscribe = sub.unsubscribe;
}

/**
 * Clean up the bridge when the app is quitting.
 */
export function destroyBridge(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  bridge = null;
}

/**
 * Get the bridge instance (for advanced use cases).
 */
export function getBridge() {
  return bridge;
}
