/**
 * The e2e docker spec's Mac mode: the app's own backend, VmBackend over
 * DefaultVmManager, against the helper, guest and CLI that
 * `npm run build:native` leaves in build/, as index.ts builds them from
 * Resources. The helper runs under its own seatbelt profile, a real VM boots
 * at the claim, and a pull is made on the Mac by the real puller.
 *
 * Two parts are stand-ins. The cache disks: every VM starts on a blank data
 * disk and no refresh VM runs, so nothing boots that the spec did not claim
 * and nothing outlives it. And the worker's proxy: a listener that answers
 * nothing, since no case here sends a container's traffic anywhere; the
 * relay to it is still what the helper profile and the guest are given.
 *
 * The spec loads this only on the Mac outside a job, once it has checked
 * that build/ holds what it needs.
 */

import './unpackaged-electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import type { DockerVmConfig } from '../../../src/main/config';
import type { WorkerDocker } from '../../../src/main/docker/docker-backend';
import { VmImagePuller } from '../../../src/main/docker/puller/image-puller';
import { RegistryClient } from '../../../src/main/docker/puller/registry-client';
import { GuestImage } from '../../../src/main/vm/guest-image';
import { DOCKER_CONFIG_DIR_NAME, HELPER_NAME, SHARE_DIR_NAME, SHARE_NONCE_FILE, vmJobFiles } from '../../../src/main/vm/paths';
import type { CacheDisks, VmHandle, VmManager } from '../../../src/main/vm/types';
import { VmBackend } from '../../../src/main/vm/vm-backend';
import { DefaultVmManager } from '../../../src/main/vm/vm-manager';

/** Small enough for a laptop running other VMs, and the smallest data disk the manager allows. */
const config: DockerVmConfig = {
  prewarm: false,
  cpus: 2,
  memoryMiB: 2048,
  maxRunning: 2,
  dataDiskGiB: 8,
  bootTimeoutSec: 60,
  cacheLimitGiB: 20,
  pullMaxGiB: 10,
  jobPullMaxGiB: 30,
  minFreeGiB: 20,
};

/** Every VM starts blank: the golden disk and its refresh VM are the puller's live checks, not this spec's. */
const blankDisks: CacheDisks = {
  prepareJobDisk: async (_repoKey, dest, sizeGiB) => {
    const file = await fs.promises.open(dest, 'wx', 0o600);
    try {
      await file.truncate(sizeGiB * 1024 ** 3);
    } finally {
      await file.close();
    }
    return 'blank';
  },
  notePulled: () => {},
  scheduleRefresh: () => {},
  discard: async () => {},
};

type Level = 'debug' | 'info' | 'warn' | 'error';

/** One worker's sandbox, laid out as buildSandbox and writeShareNonce leave it. */
export interface VmSandbox {
  sandboxDir: string;
  sandboxId: string;
  shareNonce: string;
}

export class VmHarness {
  /** Every VM the backend asked for, in order. */
  readonly started: VmHandle[] = [];
  readonly backend: VmBackend;
  private readonly manager: DefaultVmManager;

  private constructor(
    /** `<data>`, realpathed. */
    readonly data: string,
    resources: string,
    private readonly proxy: net.Server,
    private readonly log: (level: Level, message: string) => void
  ) {
    const guest = new GuestImage(path.join(resources, 'guest'));
    this.manager = new DefaultVmManager({
      dataDir: data,
      resources,
      helperPath: () => path.join(resources, HELPER_NAME),
      guest,
      config: () => config,
      runnerSlots: () => 1,
      cacheDisks: blankDisks,
      log,
    });
    const manager = this.manager;
    const seen: VmManager = {
      sweep: () => manager.sweep(),
      start: (req) => {
        const vm = manager.start(req);
        this.started.push(vm);
        return vm;
      },
      claimSpare: (vmId) => manager.claimSpare(vmId),
      onResume: () => manager.onResume(),
      onMemoryPressure: (level) => manager.onMemoryPressure(level),
      shutdownAll: () => manager.shutdownAll(),
    };
    this.backend = new VmBackend({
      vmManager: seen,
      guest,
      puller: new VmImagePuller({
        dataDir: data,
        // Anonymous: the operator's credentials play no part in the spec.
        client: new RegistryClient(),
        cacheDisks: blankDisks,
        limits: () => config,
        log,
      }),
      cacheDisks: blankDisks,
      config: () => config,
    });
  }

  /** `data` must be short: a VM's sockets are 35 or 36 bytes below it, and a socket path fits in 103. */
  static async create(data: string, resources: string, log: (level: Level, message: string) => void): Promise<VmHarness> {
    const proxy = net.createServer((client) => client.destroy());
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const harness = new VmHarness(fs.realpathSync(data), fs.realpathSync(resources), proxy, log);
      await harness.manager.sweep();
      return harness;
    } catch (err) {
      // No harness to shut down, so the listener would outlive the spec.
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      throw err;
    }
  }

  /** A sandbox for a worker in `slot`, with its share, its nonce and an empty DOCKER_CONFIG. */
  newSandbox(slot: number): VmSandbox {
    const sandboxId = `${slot}-${crypto.randomBytes(6).toString('hex')}`;
    const sandboxDir = path.join(this.data, 'runner', 'sandbox', sandboxId);
    fs.mkdirSync(path.join(sandboxDir, SHARE_DIR_NAME), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(sandboxDir, DOCKER_CONFIG_DIR_NAME), { mode: 0o700 });
    const shareNonce = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(sandboxDir, SHARE_DIR_NAME, SHARE_NONCE_FILE), shareNonce, { flag: 'wx', mode: 0o600 });
    return { sandboxDir, sandboxId, shareNonce };
  }

  /** The worker runner-manager would hand this sandbox's filtering socket (contract §5.4). */
  forWorker(slot: number, sandbox: VmSandbox, log: (entry: { level: 'debug' | 'info' | 'warn'; message: string }) => void): WorkerDocker {
    const port = (this.proxy.address() as net.AddressInfo).port;
    return this.backend.forWorker({
      slot,
      sandboxDir: sandbox.sandboxDir,
      sandboxId: sandbox.sandboxId,
      shareNonce: sandbox.shareNonce,
      proxy: () => ({ port, url: `http://localmost:e2e@127.0.0.1:${port}` }),
      log,
    });
  }

  /** A VM's own directory, `<data>/vm/jobs/<vmId>`, which goes when the VM does. */
  vmDir(vm: VmHandle): string {
    return vmJobFiles(this.data, vm.vmId).dir;
  }

  /** Stop every VM, whatever the spec left running, and the proxy's listener. */
  async shutdown(): Promise<void> {
    try {
      await this.manager.shutdownAll();
    } finally {
      await new Promise<void>((resolve) => this.proxy.close(() => resolve()));
    }
    this.log('debug', 'every VM stopped');
  }
}
