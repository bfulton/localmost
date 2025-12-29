/**
 * Zubridge integration - syncs Zustand store to renderer processes.
 */

import { BrowserWindow } from 'electron';
import { createZustandBridge } from '@zubridge/electron/main';
import { store } from './index';

// Bridge instance
let bridge: ReturnType<typeof createZustandBridge> | null = null;
let unsubscribe: (() => void) | null = null;

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

  // Create the bridge
  bridge = createZustandBridge(store);

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
