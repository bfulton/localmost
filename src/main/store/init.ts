/**
 * Store initialization - call this during app startup.
 *
 * Sets up:
 * - YAML persistence (load config from disk, save on changes)
 * - XState synchronization (sync runner machine to store)
 * - Zubridge (sync store to renderer)
 */

import { BrowserWindow } from 'electron';
import { setupPersistence, flushPersistence } from './middleware/persist';
import { setupXStateSync } from './middleware/xstate-sync';
import { initBridge, destroyBridge } from './bridge';

// Cleanup functions
let cleanupFns: (() => void)[] = [];

/**
 * Initialize the store and all middleware.
 * Call this after the runner state machine is initialized.
 */
export function initStore(): void {
  // Set up persistence (loads config from disk)
  const unsubPersist = setupPersistence();
  cleanupFns.push(unsubPersist);

  // Set up XState sync (syncs runner machine to store)
  const unsubXState = setupXStateSync();
  cleanupFns.push(unsubXState);
}

/**
 * Connect a window to the store via zubridge.
 * Call this after creating each BrowserWindow.
 */
export function connectWindow(window: BrowserWindow): void {
  initBridge(window);
}

/**
 * Clean up the store before app quit.
 */
export function cleanupStore(): void {
  // Flush any pending persistence
  flushPersistence();

  // Run all cleanup functions
  for (const cleanup of cleanupFns) {
    try {
      cleanup();
    } catch (e) {
      console.error('Store cleanup error:', e);
    }
  }
  cleanupFns = [];

  // Destroy the bridge
  destroyBridge();
}

// Re-export store for convenience
export { store, getState, setState, subscribe } from './index';
export * from './types';
