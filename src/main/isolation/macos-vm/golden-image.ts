/**
 * The golden image's life: built once from the restore image VZ offers this
 * Mac, set up for jobs, checked at each start, its slots' saved states taken
 * again after a host update, and rebuilt when the operator asks (the setup
 * page recommends it once the Mac runs a newer macOS than the image was
 * built on). See docs/roadmap/macos-vm-jobs.md ("The golden image").
 *
 *   catalog    the latest restore image VZ supports here, and its URL
 *   download   to <data>/macos-vm/ipsw/<build>.ipsw, resumed, checked against
 *              Apple's SHA-1 when published, kept until the image is ready
 *   verify     the helper reads it back: the build the catalog named
 *   install    VZMacOSInstaller into images/<id>/ (sparse disk, aux, config)
 *   provision  the first boot: headless on macOS 27 (the helper creates the
 *              administrator), else the guided setup in a window
 *   setup      over SSH: the job user, auto-login, the runner, the Command
 *              Line Tools, the agent; Remote Login off; the guest shuts down
 *   save-state each slot's own clone booted with its identity and saved
 *   check      the image as the helper sees it; then current.json
 *
 * Only one build runs at a time, and it takes its VM slots from the same
 * queue as jobs. An image is current only once current.json names it, and
 * the startup sweep removes every image directory current.json does not.
 */

import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { MacVmBuildPhase, MacVmSetupStatus } from '../../../shared/macos-vm-setup';
import { guidedSetupSteps } from '../../../shared/macos-vm-setup';
import { readablePassword, runBootstrap, type BootstrapOptions } from './bootstrap';
import { leaseFor, readLeases } from './dhcp-leases';
import type { HelperInvocation, MacVmHelper } from './helper-client';
import { GOLDEN_DISK_GIB, JOB_VM_CPUS, JOB_VM_MEMORY_MIB, hostRefusal, macosMajorOf, provisioningMode, type HostInfo } from './host';
import { assertRemovable, bootstrapDir, imageDir, ipswPath, macVmLayout, newImageId, slotDir, IMAGE_ID_RE, MAC_VM_SLOTS } from './paths';
import { downloadRestoreImage, publishedSha1, type DownloadOptions } from './restore-image';
import type { MacVmSlots, SlotNumber } from './slots';

/** What the image needs beyond the restore image: macOS, the tools, the runner, two saved states. */
export const IMAGE_ESTIMATE_BYTES = 30 * 2 ** 30;
/** What stays free on the volume through the whole build. */
export const DISK_RESERVE_BYTES = 10 * 2 ** 30;
/** The restore image's size until the download says: 26.6.2's is 18.4 GiB. */
const IPSW_ESTIMATE_BYTES = 20 * 2 ** 30;

/** The administrator the provisioning boot creates, for the setup alone. */
export const SETUP_ADMIN = { username: 'localmost-admin', fullName: 'localmost setup' };

/** current.json: the one image jobs run from. */
export interface CurrentImage {
  schema: 1;
  imageId: string;
  os: string;
  build: string;
  /** The host's macOS major and build when the image was built. */
  hostMajor: number;
  hostBuild: string;
  runnerVersion: string;
  createdAt: string;
}

/** What the backend needs of the current image. */
export interface ReadyImage {
  imageId: string;
  /** The slots with a saved state: the ones a job may run in. */
  slots: SlotNumber[];
}

export type LaunchHelper = (invocation: HelperInvocation, opts?: { window?: boolean; expectAgentSocket?: string }) => MacVmHelper;

export interface ImageManagerDeps {
  /** `<data>`, realpathed. */
  dataDir: string;
  host: () => HostInfo;
  helperExists: () => boolean;
  /** Whether the helper was built with macOS 27's guest provisioning (its `version`). */
  helperHasProvisioning: () => Promise<boolean>;
  agentBinary: () => string;
  launch: LaunchHelper;
  slots: MacVmSlots;
  /** The host's runner: its version and its arc directory. */
  runnerArc: () => { version: string; dir: string } | null;
  /** Packs the runner of `version` as a tar.gz at `dest`, from a copy checked against its integrity record. */
  packRunner: (version: string, dest: string) => Promise<void>;
  freeBytes: (dir: string) => Promise<number>;
  /** Whether a job VM runs on `imageId` now. */
  imageInUse: (imageId: string) => boolean;
  /** Whether any job VM runs now. */
  jobsRunning: () => boolean;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Injected for tests. */
  download?: (opts: DownloadOptions) => Promise<void>;
  sha1For?: (url: string) => Promise<string | null>;
  readLeases?: () => string;
  bootstrap?: (opts: BootstrapOptions) => Promise<void>;
  random?: (n: number) => Buffer;
  now?: () => number;
  leasePollMs?: number;
  leaseTimeoutMs?: number;
  /** How long after the provisioning VM stops the setup may still report done. */
  setupGraceMs?: number;
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts, leaving no timer behind. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('aborted'))), { once: true });
  });
}

class Cancelled extends Error {
  constructor() {
    super('the build was cancelled');
  }
}

/**
 * The golden image. Emits `status` with a MacVmSetupStatus whenever it
 * changes.
 */
export class MacVmImageManager extends EventEmitter {
  private current: (CurrentImage & { slots: SlotNumber[]; diskAllocatedBytes: number }) | null = null;
  private status_: MacVmSetupStatus;
  private building: { abort: AbortController; helper: MacVmHelper | null; guidedOpen?: () => void } | null = null;
  private readonly random: (n: number) => Buffer;

  constructor(private readonly deps: ImageManagerDeps) {
    super();
    this.random = deps.random ?? ((n) => crypto.randomBytes(n));
    this.status_ = { state: 'not-built', disk: { freeBytes: 0, neededBytes: 0 }, provisioning: 'guided', busy: false };
  }

  status(): MacVmSetupStatus {
    return { ...this.status_, busy: this.deps.jobsRunning() };
  }

  /** The image jobs run from, when there is one and it checked. */
  ready(): ReadyImage | null {
    return this.current && this.status_.state === 'ready' ? { imageId: this.current.imageId, slots: [...this.current.slots] } : null;
  }

  private set(patch: Partial<MacVmSetupStatus>, replace = false): void {
    const base = replace ? { disk: this.status_.disk, provisioning: this.status_.provisioning, busy: false } : this.status_;
    this.status_ = { ...base, ...patch } as MacVmSetupStatus;
    this.emit('status', this.status());
  }

  private async refreshDisk(ipswBytes?: number): Promise<void> {
    const freeBytes = await this.deps.freeBytes(macVmLayout(this.deps.dataDir).root).catch(() => 0);
    const neededBytes = this.current ? 0 : (ipswBytes ?? IPSW_ESTIMATE_BYTES) + IMAGE_ESTIMATE_BYTES + DISK_RESERVE_BYTES;
    this.status_ = { ...this.status_, disk: { freeBytes, neededBytes } };
  }

  /**
   * At app start: makes the layout, sweeps what no current.json names, and
   * checks the current image. A host build that differs from the one its
   * states were saved on gets them saved again, in the background.
   */
  async start(): Promise<void> {
    const layout = macVmLayout(this.deps.dataDir);
    for (const dir of [layout.root, layout.ipswDir, layout.imagesDir, layout.vmsDir, layout.slotsDir, layout.bootstrapDir, path.join(layout.root, 'profiles')]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const host = this.deps.host();
    const provisioning = provisioningMode(host, await this.deps.helperHasProvisioning().catch(() => false));
    this.status_ = { ...this.status_, provisioning };
    const refusal = hostRefusal(host) ?? (this.deps.helperExists() ? null : 'this build of localmost has no macOS VM helper');
    if (refusal) {
      await this.refreshDisk();
      return this.set({ state: 'unsupported', reason: refusal }, true);
    }
    const current = this.readCurrent();
    this.sweep(current?.imageId ?? null);
    if (!current) {
      await this.refreshDisk();
      return this.set({ state: 'not-built' }, true);
    }
    await this.checkCurrent(current);
  }

  private readCurrent(): CurrentImage | null {
    try {
      const value = JSON.parse(fs.readFileSync(macVmLayout(this.deps.dataDir).currentFile, 'utf8')) as CurrentImage;
      if (value.schema !== 1 || !IMAGE_ID_RE.test(value.imageId)) throw new Error('not a current.json');
      return value;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.log('warn', `macOS VM: ignoring current.json: ${(err as Error).message}`);
      return null;
    }
  }

  /** Removes every image directory but `keep`'s, bootstrap leftovers, and profiles. */
  private sweep(keep: string | null): void {
    const layout = macVmLayout(this.deps.dataDir);
    for (const name of fs.readdirSync(layout.imagesDir)) {
      const target = path.join(layout.imagesDir, name);
      if (!IMAGE_ID_RE.test(name) || name === keep || this.deps.imageInUse(name)) continue;
      assertRemovable(this.deps.dataDir, target, 'images', IMAGE_ID_RE);
      fs.rmSync(target, { recursive: true, force: true });
      this.deps.log('info', `macOS VM: removed image ${name}, which no current.json names`);
    }
    for (const name of fs.readdirSync(layout.bootstrapDir)) {
      if (!IMAGE_ID_RE.test(name)) continue;
      const target = path.join(layout.bootstrapDir, name);
      assertRemovable(this.deps.dataDir, target, 'bootstrap', IMAGE_ID_RE);
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  private async checkCurrent(current: CurrentImage): Promise<void> {
    let result: Record<string, unknown>;
    try {
      result = await this.deps.launch({ command: 'check', dataDir: this.deps.dataDir, imageId: current.imageId }).result();
    } catch (err) {
      await this.refreshDisk();
      return this.set({ state: 'failed', reason: `the golden image failed its check: ${(err as Error).message}` }, true);
    }
    if (result.supported !== true) {
      return this.set({ state: 'failed', reason: "this Mac cannot run the golden image's hardware model; rebuild it" }, true);
    }
    const host = this.deps.host();
    const states = result.states as Record<string, { hostBuild: string; cpus: number; memoryMiB: number }>;
    const slots = MAC_VM_SLOTS.filter((s) => states[String(s)] !== undefined) as SlotNumber[];
    this.current = { ...current, slots, diskAllocatedBytes: result.diskAllocatedBytes as number };
    const hostMajor = macosMajorOf(host.darwin) ?? 0;
    await this.refreshDisk();
    this.set(
      {
        state: slots.length > 0 ? 'ready' : 'failed',
        ...(slots.length > 0 ? {} : { reason: 'the golden image has no saved state; rebuild it' }),
        image: { os: current.os, build: current.build, diskAllocatedBytes: this.current.diskAllocatedBytes, slots, stale: hostMajor > current.hostMajor },
      },
      true
    );
    const outdated = slots.filter((s) => {
      const st = states[String(s)];
      return st.hostBuild !== host.build || st.cpus !== JOB_VM_CPUS || st.memoryMiB !== JOB_VM_MEMORY_MIB;
    });
    if (outdated.length > 0 && host.build) {
      this.deps.log('info', `macOS VM: saving slot ${outdated.join(' and ')} again for this Mac's macOS build ${host.build}`);
      void this.resave(current.imageId, outdated);
    }
  }

  /** Saves slots' states again; until then jobs in them boot cold. */
  private async resave(imageId: string, slots: SlotNumber[]): Promise<void> {
    for (const slot of slots) {
      try {
        await this.saveState(imageId, slot);
      } catch (err) {
        this.deps.log('warn', `macOS VM: slot ${slot}'s state could not be saved again: ${(err as Error).message}`);
      }
    }
  }

  private async saveState(imageId: string, slot: SlotNumber, signal?: AbortSignal): Promise<void> {
    const held = await this.deps.slots.acquire(`save-state ${slot}`, [slot], signal);
    try {
      const helper = this.deps.launch({ command: 'save-state', dataDir: this.deps.dataDir, imageId, slot: held, cpus: JOB_VM_CPUS, memoryMiB: JOB_VM_MEMORY_MIB });
      if (this.building) this.building.helper = helper;
      await helper.result();
    } finally {
      this.deps.slots.release(held);
    }
  }

  /** Starts a build. Its progress and its end are in the status. */
  build(): void {
    if (this.building) throw new Error('a golden image is already being built');
    const refusal = hostRefusal(this.deps.host()) ?? (this.deps.helperExists() ? null : 'this build of localmost has no macOS VM helper');
    if (refusal) throw new Error(refusal);
    if (!this.deps.runnerArc()) throw new Error('download the runner first: the golden image gets the same runner as this Mac');
    const abort = new AbortController();
    this.building = { abort, helper: null };
    void this.runBuild(abort.signal)
      .catch(async (err) => {
        const cancelled = err instanceof Cancelled || abort.signal.aborted;
        this.deps.log(cancelled ? 'info' : 'error', `macOS VM: the golden image build ${cancelled ? 'was cancelled' : `failed: ${(err as Error).message}`}`);
        await this.refreshDisk();
        if (this.current) {
          this.set({ state: 'ready', image: this.status_.image, ...(cancelled ? {} : { reason: `the rebuild failed: ${(err as Error).message}` }) }, true);
        } else {
          this.set(cancelled ? { state: 'not-built' } : { state: 'failed', reason: (err as Error).message }, true);
        }
      })
      .finally(() => {
        this.building = null;
      });
  }

  cancel(): void {
    if (!this.building) return;
    this.building.abort.abort();
    this.building.helper?.kill();
  }

  /** On a Mac before macOS 27: opens the provisioning VM in a window for the guided setup. */
  openGuidedSetup(): void {
    if (!this.building?.guidedOpen) throw new Error('the build is not waiting for the guided setup');
    this.building.guidedOpen();
  }

  /** Removes the current image, once no job runs on it. */
  remove(): void {
    if (this.building) throw new Error('cancel the build first');
    if (!this.current) return;
    if (this.deps.imageInUse(this.current.imageId)) throw new Error('a macOS VM job is running on the image; remove it once the job ends');
    const target = imageDir(this.deps.dataDir, this.current.imageId);
    fs.rmSync(macVmLayout(this.deps.dataDir).currentFile, { force: true });
    assertRemovable(this.deps.dataDir, target, 'images', IMAGE_ID_RE);
    fs.rmSync(target, { recursive: true, force: true });
    this.deps.log('info', `macOS VM: removed golden image ${this.current.imageId}`);
    this.current = null;
    void this.refreshDisk().then(() => this.set({ state: 'not-built' }, true));
  }

  private phase(phase: MacVmBuildPhase, step: string, percent?: number): void {
    this.set({ state: 'building', phase, step, ...(percent !== undefined ? { percent } : { percent: undefined }), guided: undefined, reason: undefined });
  }

  private async runBuild(signal: AbortSignal): Promise<void> {
    const d = this.deps;
    const check = () => {
      if (signal.aborted) throw new Cancelled();
    };
    this.phase('catalog', 'Asking which macOS this Mac can run in a VM');
    const catalogHelper = d.launch({ command: 'catalog' });
    this.building!.helper = catalogHelper;
    const catalog = await catalogHelper.result();
    check();
    if (catalog.supported !== true) throw new Error(`this Mac cannot run macOS ${catalog.os} in a VM`);
    const build = catalog.build as string;
    const os = catalog.os as string;
    const url = catalog.url as string;

    const ipsw = ipswPath(d.dataDir, `${build}.ipsw`);
    if (!fs.existsSync(ipsw)) {
      this.phase('download', `Downloading macOS ${os} (${build})`, 0);
      const sha1 = await (d.sha1For ?? publishedSha1)(url).catch((err) => {
        d.log('warn', `macOS VM: Apple's IPSW catalog could not be read (${(err as Error).message}); the download rests on TLS and the installer's own checks`);
        return null;
      });
      d.log('info', sha1 ? `macOS VM: Apple publishes SHA-1 ${sha1} for ${build}` : `macOS VM: Apple publishes no SHA-1 for ${build}`);
      let lastPercent = -1;
      await (d.download ?? downloadRestoreImage)({
        url, dest: ipsw, sha1, signal, freeBytes: d.freeBytes, reserveBytes: IMAGE_ESTIMATE_BYTES + DISK_RESERVE_BYTES,
        onProgress: (received, total) => {
          const percent = Math.floor((received / total) * 100);
          if (percent !== lastPercent) {
            lastPercent = percent;
            this.phase('download', `Downloading macOS ${os} (${build})`, percent);
          }
        },
      });
      check();
    }

    this.phase('verify', `Reading the macOS ${os} restore image`);
    const inspected = await d.launch({ command: 'inspect', ipsw }).result();
    check();
    if (inspected.build !== build || inspected.supported !== true) {
      fs.rmSync(ipsw, { force: true });
      throw new Error(`the downloaded restore image is ${inspected.build}, not the ${build} the catalog named; it was discarded`);
    }

    const imageId = newImageId();
    const dir = imageDir(d.dataDir, imageId);
    fs.mkdirSync(dir, { mode: 0o700 });
    for (const slot of MAC_VM_SLOTS) fs.mkdirSync(slotDir(d.dataDir, imageId, slot), { mode: 0o700 });
    const boot = bootstrapDir(d.dataDir, imageId);
    fs.mkdirSync(boot, { mode: 0o700 });
    try {
      await this.installAndSetUp(imageId, ipsw, os, build, boot, signal);
    } catch (err) {
      for (const [target, kind] of [[dir, 'images'], [boot, 'bootstrap']] as const) {
        assertRemovable(d.dataDir, target, kind, IMAGE_ID_RE);
        fs.rmSync(target, { recursive: true, force: true });
      }
      throw err;
    }
  }

  private async installAndSetUp(imageId: string, ipsw: string, os: string, build: string, boot: string, signal: AbortSignal): Promise<void> {
    const d = this.deps;
    const check = () => {
      if (signal.aborted) throw new Cancelled();
    };
    const arc = d.runnerArc();
    if (!arc) throw new Error('the runner is not downloaded');
    // One slot through install, provisioning and the setup: the image is
    // installed and first booted with that slot's identity.
    const slot = await d.slots.acquire('golden image build', [1, 2], signal);
    try {
      this.phase('install', `Installing macOS ${os} into the golden image`, 0);
      const install = d.launch({ command: 'install', dataDir: d.dataDir, imageId, ipsw, diskGiB: GOLDEN_DISK_GIB, slot });
      this.building!.helper = install;
      install.on('progress', (p: { phase: string; percent: number }) => {
        if (p.phase === 'install') this.phase('install', `Installing macOS ${os} into the golden image`, p.percent);
      });
      await install.result();
      check();

      const account = { ...SETUP_ADMIN, password: readablePassword(this.random) };
      const headless = this.status_.provisioning === 'headless';
      if (!headless) {
        // The operator opens the window when ready to type in it.
        await new Promise<void>((resolve, reject) => {
          this.building!.guidedOpen = resolve;
          signal.addEventListener('abort', () => reject(new Cancelled()), { once: true });
          this.set({
            state: 'needs-guided-setup', phase: 'provision', step: 'Waiting for you to open the setup window', percent: undefined,
            guided: { ...account, steps: guidedSetupSteps(account), windowOpen: false },
          });
        });
        this.building!.guidedOpen = undefined;
      }
      this.set({
        state: 'building', phase: 'provision',
        step: headless ? 'Starting the first boot' : 'Complete the steps in the setup window',
        ...(headless ? { guided: undefined } : { guided: { ...account, steps: guidedSetupSteps(account), windowOpen: true } }),
      });
      const provision = d.launch(
        { command: 'provision', dataDir: d.dataDir, imageId, slot, display: headless ? 'none' : 'window' },
        { window: !headless }
      );
      this.building!.helper = provision;
      provision.start();
      const exited = provision.exited();
      // However this boot ends - the setup fails, the reachable-wait times
      // out, the build is cancelled, or the guest shuts itself down - the
      // provisioning helper and its VM must be stopped before we return, or
      // one of the Mac's two VMs stays up until the app restarts (the same
      // leak release() guards against for job VMs). stop(0) is a no-op once
      // the helper has exited, so the clean path pays nothing.
      try {
        if (headless) {
          await Promise.race([new Promise((resolve) => provision.once('ready', resolve)), exited]);
          if (!provision.hasExited()) provision.send({ op: 'provision', ...account });
        } else {
          provision.send({ op: 'guide', ...account });
        }
        const started = await Promise.race([new Promise<{ mac?: string }>((resolve) => provision.once('started', resolve)), exited.then(() => null)]);
        if (!started?.mac) throw new Error(`the first boot did not start: ${(await exited).end?.message ?? (await exited).errorCode}`);
        check();

        this.set({ phase: 'setup', step: 'Waiting for the VM to get an address' });
        const ip = await this.waitForLease(started.mac, signal, exited);
        const tarball = path.join(boot, 'runner.tar.gz');
        await d.packRunner(arc.version, tarball);
        this.set({ phase: 'setup', step: headless ? 'Setting up the VM over Remote Login' : 'Waiting for Remote Login to be turned on in the VM' });
        // The setup runs while the VM is up. A VM that stops first - its
        // window closed, say - ends the setup too, once the guest's own
        // shutdown at the end of a finished setup has had time to be reported.
        const setupAbort = new AbortController();
        signal.addEventListener('abort', () => setupAbort.abort(), { once: true });
        let setUp = false;
        const setup = (d.bootstrap ?? runBootstrap)({
          ip, account, dir: boot, agentBinary: d.agentBinary(), runnerTarball: tarball, signal: setupAbort.signal,
          inputs: {
            jobPassword: crypto.randomBytes(24).toString('base64url'),
            discardedAdminPassword: crypto.randomBytes(24).toString('base64url'),
            runnerVersion: arc.version, osVersion: os, osBuild: build,
          },
          onStep: (index, of, what) => this.set({ phase: 'setup', step: `Setting up the VM: ${what}`, percent: Math.floor(((index - 1) / of) * 100), guided: undefined }),
          log: (level, message) => d.log(level, `macOS VM setup: ${message}`),
        }).then(() => {
          setUp = true;
        });
        const grace = new AbortController();
        const stoppedFirst = exited.then(async () => {
          await delay(d.setupGraceMs ?? 15_000, grace.signal).catch(() => {});
          if (!setUp && !grace.signal.aborted) {
            setupAbort.abort();
            throw new Error('the VM stopped before its setup finished');
          }
        });
        stoppedFirst.catch(() => {});
        try {
          await Promise.race([setup, stoppedFirst.then(() => setup)]);
        } finally {
          grace.abort();
        }
        check();
        // The setup shuts the guest down, which ends the provisioning helper.
        const shutdown = new AbortController();
        const end = await Promise.race([exited, delay(10 * 60_000, shutdown.signal).then(() => null, () => null)]);
        shutdown.abort();
        if (!end) throw new Error('the VM did not shut down after its setup');
        if (end.errorCode) throw new Error(`the first boot ended badly: ${end.end?.message ?? end.errorCode}`);
      } finally {
        if (!provision.hasExited()) await provision.stop(0);
      }
    } finally {
      d.slots.release(slot);
    }
    check();

    this.set({ phase: 'save-state', step: 'Saving slot 1 for fast job starts', percent: undefined, guided: undefined });
    await this.saveState(imageId, 1, signal);
    check();
    this.set({ phase: 'save-state', step: 'Saving slot 2 for fast job starts' });
    try {
      await this.saveState(imageId, 2, signal);
    } catch (err) {
      if (signal.aborted) throw new Cancelled();
      // Slot 2's identity is the one never booted before; a failure leaves
      // the image serving one job at a time.
      d.log('warn', `macOS VM: slot 2 could not be saved, so jobs run one at a time: ${(err as Error).message}`);
    }
    check();

    this.phase('check', 'Checking the golden image');
    fs.rmSync(boot, { recursive: true, force: true });
    // Kept until now so that a build stopped part way resumes without
    // downloading 18 GB again.
    fs.rmSync(ipsw, { force: true });
    const previous = this.current;
    const host = d.host();
    const current: CurrentImage = {
      schema: 1, imageId, os, build, hostMajor: macosMajorOf(host.darwin) ?? 0, hostBuild: host.build,
      runnerVersion: arc.version, createdAt: new Date((d.now ?? Date.now)()).toISOString(),
    };
    const file = macVmLayout(d.dataDir).currentFile;
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    await this.checkCurrent(current);
    if (previous && previous.imageId !== imageId && !d.imageInUse(previous.imageId)) {
      const old = imageDir(d.dataDir, previous.imageId);
      assertRemovable(d.dataDir, old, 'images', IMAGE_ID_RE);
      fs.rmSync(old, { recursive: true, force: true });
    }
  }

  private async waitForLease(mac: string, signal: AbortSignal, exited: Promise<unknown>): Promise<string> {
    const d = this.deps;
    const read = d.readLeases ?? (() => readLeases());
    const deadline = Date.now() + (d.leaseTimeoutMs ?? 60 * 60_000);
    let gone = false;
    void exited.then(() => (gone = true));
    for (;;) {
      if (signal.aborted) throw new Cancelled();
      if (gone) throw new Error('the VM stopped before it had an address');
      const ip = leaseFor(read(), mac, Math.floor((d.now ?? Date.now)() / 1000));
      if (ip) return ip;
      if (Date.now() > deadline) throw new Error('the VM got no address from its NAT network');
      await new Promise((resolve) => setTimeout(resolve, d.leasePollMs ?? 2000));
    }
  }
}
