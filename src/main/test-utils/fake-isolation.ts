/**
 * A stand-in for the macOS VM backend, for the runner manager's tests: every
 * call recorded, prepare and release resolving at once, and spawnWorker
 * handing out a worker the test drives by emitting its line and exit events.
 */

import { EventEmitter } from 'events';
import type { IsolationAvailability, IsolationBackend, IsolationJob, JobSignal, WorkerHandle } from '../isolation/macos-vm/types';

/** A worker as the backend hands one out: emit `stdout`/`stderr` with a line, `exit` with a code and signal. */
export type MockWorker = WorkerHandle & EventEmitter;

export function createMockWorker(pid: number): MockWorker {
  const worker = new EventEmitter();
  Object.defineProperty(worker, 'pid', { value: pid, writable: false, enumerable: true });
  return worker as MockWorker;
}

export interface FakeIsolation extends IsolationBackend {
  available: jest.Mock<IsolationAvailability, []>;
  vmLimit: jest.Mock<number, []>;
  jobCapacity: jest.Mock<number, []>;
  prepare: jest.Mock<Promise<void>, [IsolationJob, AbortSignal?, number?]>;
  spawnWorker: jest.Mock<Promise<WorkerHandle>, [IsolationJob, string[], Record<string, string>]>;
  signal: jest.Mock<Promise<void>, [IsolationJob, JobSignal]>;
  release: jest.Mock<Promise<void>, [IsolationJob]>;
}

/** A backend that is available for two VMs, prepares at once and hands out a new worker per spawn. */
export function fakeIsolation(): FakeIsolation {
  let nextPid = 1000;
  return {
    type: 'macos-vm',
    available: jest.fn((): IsolationAvailability => ({ ok: true })),
    vmLimit: jest.fn((): number => 2),
    jobCapacity: jest.fn((): number => 2),
    prepare: jest.fn(async (_job: IsolationJob, _signal?: AbortSignal, _slotWaitMs?: number): Promise<void> => undefined),
    spawnWorker: jest.fn(
      async (_job: IsolationJob, _argv: string[], _env: Record<string, string>): Promise<WorkerHandle> => createMockWorker(++nextPid)
    ),
    signal: jest.fn(async (_job: IsolationJob, _signal: JobSignal): Promise<void> => undefined),
    release: jest.fn(async (_job: IsolationJob): Promise<void> => undefined),
  };
}
