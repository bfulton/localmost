/**
 * Mock for @zubridge/electron module in tests.
 * This prevents the real createUseStore from being called during module initialization.
 */

import { useCallback } from 'react';

// Mock state that tests can modify
let mockState: unknown = null;

/**
 * Set the mock state for tests.
 */
export function __setMockState(state: unknown): void {
  mockState = state;
}

/**
 * Reset the mock state.
 */
export function __resetMockState(): void {
  mockState = null;
}

/**
 * Mock createUseStore - returns a hook that reads from mockState.
 * Importantly, we still run the selector even with null state, since
 * the real selectors use optional chaining to handle null gracefully.
 */
export function createUseStore<T>() {
  return function useStore<R>(selector?: (state: T) => R): R | T | null {
    if (selector) {
      // Run the selector even with null state - selectors should handle null gracefully
      return selector(mockState as T);
    }
    return mockState as T;
  };
}

/**
 * Mock useDispatch - returns a no-op dispatcher.
 */
export function useDispatch<_T>() {
  return useCallback((action: unknown) => {
    // No-op in tests - actions are not dispatched
    console.debug('[zubridge mock] dispatch:', action);
  }, []);
}
