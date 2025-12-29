/**
 * Mock Process Utilities
 *
 * Provides properly typed mock child processes for testing.
 */

import { EventEmitter } from 'events';
import { ChildProcess } from 'child_process';

/**
 * Mock ChildProcess for testing.
 * Implements the minimal interface needed by runner tests.
 */
export interface MockChildProcess extends EventEmitter {
  readonly pid: number;
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  kill: jest.Mock;
}

/**
 * Create a mock ChildProcess with the given PID.
 * Returns a type compatible with ChildProcess for use with mocked functions.
 */
export function createMockProcess(pid: number): ChildProcess {
  const proc = new EventEmitter();

  // Define pid as readonly property
  Object.defineProperty(proc, 'pid', {
    value: pid,
    writable: false,
    enumerable: true,
  });

  // Create stdout/stderr as EventEmitters
  Object.defineProperty(proc, 'stdout', {
    value: new EventEmitter(),
    writable: false,
    enumerable: true,
  });

  Object.defineProperty(proc, 'stderr', {
    value: new EventEmitter(),
    writable: false,
    enumerable: true,
  });

  // Add mock kill function
  Object.defineProperty(proc, 'kill', {
    value: jest.fn(),
    writable: false,
    enumerable: true,
  });

  // Cast to ChildProcess - the mock provides the minimal interface needed
  return proc as unknown as ChildProcess;
}
