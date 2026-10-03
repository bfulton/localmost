/**
 * The macOS VM isolation mode, put together: the golden image's manager,
 * the job backend and the slot queue they share, with the real helper, its
 * profiles and the host's runner. The wiring step creates one at app start,
 * calls start() before the pool takes jobs, registers the setup IPC with
 * its manager (ipc-handlers/macos-vm.ts), and hands the backend jobs whose
 * isolation is `macos-vm`. See docs/roadmap/macos-vm-jobs.md.
 */

import * as fs from 'fs';
import { MacVmBackend } from './backend';
import { MacVmImageManager } from './golden-image';
import { concurrentVmLimit, currentHost } from './host';
import { helperHasProvisioning, launcher, packRunner, runnerArchive } from './launch';
import { macVmAgentPath, macVmHelperPath } from './paths';
import { MacVmSlots } from './slots';
import { processExecutableOf } from '../../vm/vm-manager';

export type { IsolationBackend, IsolationAvailability, IsolationJob, JobSignal, WorkerHandle } from './types';

export interface MacVmModeOptions {
  /** `<data>`, realpathed. */
  dataDir: string;
  /** The host's runner: its version and arc directory, or null before one is downloaded. */
  runnerArc: () => { version: string; dir: string } | null;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export interface MacVmMode {
  images: MacVmImageManager;
  backend: MacVmBackend;
  slots: MacVmSlots;
  /** The startup sweep and the golden image's check. */
  start(): Promise<void>;
}

export function createMacVmMode(opts: MacVmModeOptions): MacVmMode {
  const host = currentHost();
  const launch = launcher(opts.dataDir, opts.log);
  const helperExists = () => fs.existsSync(macVmHelperPath());
  let images: MacVmImageManager | null = null;
  // Memory bounds how many run at once; which slots a job may use is the
  // image's (the backend asks only for slots with a saved state, since a
  // slot without one has an identity no boot has proved).
  const slots = new MacVmSlots(() => concurrentVmLimit(host.totalMemoryBytes));
  const backend = new MacVmBackend({
    dataDir: opts.dataDir,
    images: { ready: () => images?.ready() ?? null, status: () => images?.status() ?? { state: 'not-built' } },
    slots,
    host: () => host,
    helperExists,
    launch,
    runnerArchive: async (version) => {
      const arc = opts.runnerArc();
      if (!arc || arc.version !== version) throw new Error(`runner ${version} is not this Mac's runner`);
      return runnerArchive(opts.dataDir, version, arc.dir);
    },
    log: opts.log,
    processExecutable: processExecutableOf,
    helperPath: macVmHelperPath,
  });
  images = new MacVmImageManager({
    dataDir: opts.dataDir,
    host: () => host,
    helperExists,
    helperHasProvisioning,
    agentBinary: macVmAgentPath,
    launch,
    slots,
    runnerArc: opts.runnerArc,
    packRunner,
    freeBytes: async (dir) => {
      const stats = await fs.promises.statfs(dir);
      return stats.bavail * stats.bsize;
    },
    imageInUse: (id) => backend.imageInUse(id),
    jobsRunning: () => backend.jobsRunning(),
    log: opts.log,
  });
  const manager = images;
  return {
    images: manager,
    backend,
    slots,
    async start() {
      await backend.sweep();
      await manager.start();
    },
  };
}
