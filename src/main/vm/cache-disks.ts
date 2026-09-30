/**
 * The per-repository golden data disks (contract §6.5).
 *
 * Each job's VM gets an APFS clone of its repository's golden disk, which
 * holds the public images the repository pulled, already loaded, so that a
 * later job's pull is a cache hit in the VM. The golden disk is written only
 * by a refresh VM: no share, no relay, never job code. It loads verified
 * images from the Mac-side store into a clone of the golden disk (or a blank
 * one), removes everything else, and the result replaces the golden disk only
 * after the helper reports a synced clean stop.
 *
 * Because the refresh VM writes untrusted layers into state that outlives a
 * job, a refresh starts from blank when the guest changed, when the golden
 * disk was last built from blank more than 7 days ago, after any failed
 * refresh, and when the cache limit dropped images.
 *
 * CacheDisks takes a StartRefreshVm instead of importing VmManager, so that
 * it can be built and tested against a fake.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { DaemonConnector, DaemonError, listImages, loadImage, removeImage } from '../docker/puller/daemon-api';
import { dockerArchive, ArchiveLayer } from '../docker/puller/docker-archive';
import { blobsOf, ImageStore, StoreRef } from '../docker/puller/image-store';
import { cacheFiles, DIGEST_RE, imageStoreDir, REPO_KEY_RE, REFRESH_SLOT, repoKeyOf, VM_ID_RE, vmIdSlot, vmJobFiles } from './paths';
import type { CacheDisks as CacheDisksApi, StartRefreshVm, VmHandle } from './types';

const GiB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A golden disk last built from blank longer ago than this is rebuilt from blank. */
const REBUILD_AFTER_MS = 7 * DAY_MS;
const DEBOUNCE_MS = 60_000;
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const MAX_META_BYTES = 4 * 1024 * 1024;
const GUEST_VERSION_RE = /^[\x21-\x7e]{1,64}$/;

export interface GuestInfo {
  guestVersion: string;
  dataFormat: number;
}

export interface CacheDisksOptions {
  /** `<data>`, realpathed. */
  dataDir: string;
  startRefreshVm: StartRefreshVm;
  /** The bundled guest's manifest: its version and its data-disk format. */
  guest: () => GuestInfo;
  /** dockerVm.cacheLimitGiB: the store and the golden disk together, per repository. */
  cacheLimitGiB: () => number;
  /** dockerVm.dataDiskGiB: the apparent size of a blank refresh disk. */
  dataDiskGiB: () => number;
  /** A refresh waits while either holds. */
  conditions?: () => { onBattery: boolean; memoryPressure: 'normal' | 'warn' | 'critical' };
  debounceMs?: number;
  now?: () => number;
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
  /** Tests only: how to reach a VM's docker.sock (see DaemonConnector). */
  connectDaemon?: DaemonConnector;
}

/** meta.json: what the golden disk holds and how it was made. */
interface Meta {
  v: 1;
  dataFormat: number;
  guestVersion: string;
  configDigests: string[];
  /** When the golden disk was last built from a blank disk (ms). */
  builtFromBlankAt: number;
  lastRefreshAt: number;
  lastRefreshFailed: boolean;
}

function validMeta(value: unknown): Meta | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  if (m.v !== 1) return null;
  if (typeof m.dataFormat !== 'number' || !Number.isSafeInteger(m.dataFormat)) return null;
  if (typeof m.guestVersion !== 'string' || !GUEST_VERSION_RE.test(m.guestVersion)) return null;
  if (!Array.isArray(m.configDigests) || !m.configDigests.every((d) => typeof d === 'string' && DIGEST_RE.test(d))) return null;
  if (typeof m.builtFromBlankAt !== 'number' || typeof m.lastRefreshAt !== 'number') return null;
  if (typeof m.lastRefreshFailed !== 'boolean') return null;
  return {
    v: 1,
    dataFormat: m.dataFormat,
    guestVersion: m.guestVersion,
    configDigests: m.configDigests as string[],
    builtFromBlankAt: m.builtFromBlankAt,
    lastRefreshAt: m.lastRefreshAt,
    lastRefreshFailed: m.lastRefreshFailed,
  };
}

const execFileAsync = promisify(execFile);

/**
 * Copy a disk image as cheaply as the file system allows: an APFS clone on
 * darwin, which costs about 4 ms and no space until either file is written.
 *
 * Node cannot clone on macOS: its libuv answers COPYFILE_FICLONE_FORCE with
 * ENOSYS and makes a full byte copy for COPYFILE_FICLONE (measured on macOS
 * 26 with Node 22). So darwin uses `/bin/cp -c`, which calls clonefile(2).
 * cp falls back to a copy only across volumes or on a file system that cannot
 * clone; the first is refused here, and `<data>` is on the boot volume, APFS.
 * Elsewhere (the Linux CI leg) it is a plain copy, with a reflink where the
 * file system has one. Either way `dest` must not exist.
 */
export async function cloneFile(src: string, dest: string): Promise<void> {
  if (process.platform !== 'darwin') {
    await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    return;
  }
  const [from, into] = await Promise.all([fs.promises.lstat(src), fs.promises.stat(path.dirname(dest))]);
  if (!from.isFile()) throw new Error(`not a disk image file: ${src}`);
  if (from.dev !== into.dev) throw new Error(`${src} and ${dest} are on different volumes, so one cannot be a clone of the other`);
  const exists = await fs.promises.lstat(dest).then(() => true, () => false);
  if (exists) throw Object.assign(new Error(`${dest} already exists`), { code: 'EEXIST' });
  await execFileAsync('/bin/cp', ['-c', '-n', src, dest], { timeout: 120_000 });
  const made = await fs.promises.lstat(dest);
  if (!made.isFile() || made.ino === from.ino || made.size !== from.size) throw new Error(`cp -c did not make ${dest}`);
}

/** A new sparse file of `sizeGiB` apparent size, which must not already exist. */
async function createSparse(file: string, sizeGiB: number): Promise<void> {
  const handle = await fs.promises.open(file, 'wx', 0o600);
  try {
    await handle.truncate(Math.floor(sizeGiB * GiB));
  } finally {
    await handle.close();
  }
}

/** `<registry>/<path>` from a stored reference, for the archive's image name. */
function imageName(ref: string): string {
  const at = ref.indexOf('@');
  if (at >= 0) return ref.slice(0, at);
  const colon = ref.lastIndexOf(':');
  return colon > ref.lastIndexOf('/') ? ref.slice(0, colon) : ref;
}

export class CacheDisks implements CacheDisksApi {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Map<string, string>();
  private readonly pending = new Map<string, Set<string>>();
  private readonly generation = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly now: () => number;
  private readonly log: (level: 'debug' | 'info' | 'warn', message: string) => void;

  constructor(private readonly options: CacheDisksOptions) {
    if (!path.isAbsolute(options.dataDir)) throw new Error('CacheDisks needs an absolute data directory');
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  private files(repoKey: string) {
    if (!REPO_KEY_RE.test(repoKey)) throw new Error(`not a repository key: ${JSON.stringify(repoKey)}`);
    return cacheFiles(this.options.dataDir, repoKey);
  }

  private async readMeta(repoKey: string): Promise<Meta | null> {
    try {
      const handle = await fs.promises.open(this.files(repoKey).meta, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if ((await handle.stat()).size > MAX_META_BYTES) return null;
        return validMeta(JSON.parse(await handle.readFile('utf-8')));
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  private async writeMeta(repoKey: string, meta: Meta): Promise<void> {
    const { dir, meta: file } = this.files(repoKey);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}-${this.now()}`;
    await fs.promises.writeFile(tmp, JSON.stringify(meta, null, 1), { mode: 0o600 });
    await fs.promises.rename(tmp, file);
  }

  async prepareJobDisk(repoKey: string, dest: string, sizeGiB: number): Promise<'clone' | 'blank'> {
    const { golden } = this.files(repoKey);
    const vmId = path.basename(path.dirname(dest));
    if (!VM_ID_RE.test(vmId) || vmJobFiles(this.options.dataDir, vmId).dataDisk !== dest) {
      throw new Error(`not a VM's data disk: ${dest}`);
    }
    const meta = await this.readMeta(repoKey);
    const guest = this.options.guest();
    if (meta && meta.dataFormat !== guest.dataFormat) {
      await this.discard(repoKey, 'dataFormat');
    } else if (meta) {
      try {
        const stat = await fs.promises.lstat(golden);
        if (stat.isFile() && stat.size <= sizeGiB * GiB) {
          await cloneFile(golden, dest);
          return 'clone';
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error;
        // No golden disk, or it could not be cloned: a blank disk instead.
      }
    }
    await createSparse(dest, sizeGiB);
    return 'blank';
  }

  notePulled(repoKey: string, configDigest: string): void {
    if (!REPO_KEY_RE.test(repoKey) || !DIGEST_RE.test(configDigest)) return;
    let set = this.pending.get(repoKey);
    if (!set) {
      set = new Set();
      this.pending.set(repoKey, set);
    }
    set.add(configDigest);
  }

  scheduleRefresh(repoKey: string, repository: string): void {
    if (!REPO_KEY_RE.test(repoKey) || repoKeyOf(repository) !== repoKey) {
      this.log('warn', `not scheduling a cache refresh: ${repository} is not the repository of ${repoKey}`);
      return;
    }
    const existing = this.timers.get(repoKey);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(repoKey);
      void this.fire(repoKey, repository);
    }, this.options.debounceMs ?? DEBOUNCE_MS);
    timer.unref?.();
    this.timers.set(repoKey, timer);
  }

  private async fire(repoKey: string, repository: string): Promise<void> {
    const running = this.running.get(repoKey);
    if (running) {
      // One at a time: run again once this one is done.
      this.again.set(repoKey, repository);
      return;
    }
    const conditions = this.options.conditions?.();
    if (conditions && (conditions.onBattery || conditions.memoryPressure !== 'normal')) {
      this.log('debug', `cache refresh for ${repository} waits: ${conditions.onBattery ? 'on battery' : `memory pressure ${conditions.memoryPressure}`}`);
      this.scheduleRefresh(repoKey, repository);
      return;
    }
    const run = this.refresh(repoKey, repository).catch((error) => {
      this.log('warn', `cache refresh for ${repository} failed: ${(error as Error).message}`);
    });
    this.running.set(repoKey, run);
    await run;
    this.running.delete(repoKey);
    const next = this.again.get(repoKey);
    if (next !== undefined) {
      this.again.delete(repoKey);
      this.scheduleRefresh(repoKey, next);
    }
    this.wake(repoKey);
  }

  private wake(repoKey: string): void {
    if (this.timers.has(repoKey) || this.running.has(repoKey)) return;
    for (const resolve of this.waiters.get(repoKey) ?? []) resolve();
    this.waiters.delete(repoKey);
  }

  /** Resolves once no refresh of the repository is scheduled or running. For tests and shutdown. */
  settled(repoKey: string): Promise<void> {
    if (!this.timers.has(repoKey) && !this.running.has(repoKey)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.waiters.get(repoKey) ?? [];
      list.push(resolve);
      this.waiters.set(repoKey, list);
    });
  }

  async discard(repoKey: string, reason: 'corrupt' | 'dataFormat' | 'limit'): Promise<void> {
    const { golden, meta } = this.files(repoKey);
    this.generation.set(repoKey, (this.generation.get(repoKey) ?? 0) + 1);
    await fs.promises.rm(golden, { force: true });
    await fs.promises.rm(meta, { force: true });
    this.log('info', `discarded the golden disk of ${repoKey}: ${reason}`);
  }

  /** One refresh (§6.5): choose full or incremental, load in a refresh VM, promote only a synced disk. */
  private async refresh(repoKey: string, repository: string): Promise<void> {
    const files = this.files(repoKey);
    const guest = this.options.guest();
    const generation = this.generation.get(repoKey) ?? 0;
    const store = new ImageStore(imageStoreDir(this.options.dataDir, repoKey), (message) => this.log('warn', message));
    const meta = await this.readMeta(repoKey);
    const hasGolden = await fs.promises.lstat(files.golden).then((s) => s.isFile(), () => false);

    const { kept, dropped } = await store.trim(this.options.cacheLimitGiB() * GiB);
    const images = new Map<string, StoreRef>();
    for (const ref of kept) if (!images.has(ref.configDigest)) images.set(ref.configDigest, ref);

    const now = this.now();
    const fullBecause =
      !hasGolden || !meta ? 'there is no golden disk'
        : meta.dataFormat !== guest.dataFormat || meta.guestVersion !== guest.guestVersion ? 'the guest changed'
          : now - meta.builtFromBlankAt > REBUILD_AFTER_MS ? 'it was last built from blank over 7 days ago'
            : meta.lastRefreshFailed ? 'the last refresh failed'
              : dropped.length > 0 ? `the cache limit dropped ${dropped.length} image${dropped.length === 1 ? '' : 's'}`
                : null;
    const held = new Set(meta?.configDigests ?? []);
    const toLoad = fullBecause ? [...images.values()] : [...images.values()].filter((r) => !held.has(r.configDigest));
    if (!fullBecause && toLoad.length === 0) {
      this.log('debug', `cache refresh for ${repository}: the golden disk already holds every image`);
      this.pending.delete(repoKey);
      return;
    }
    if (images.size === 0) {
      if (hasGolden) await this.discard(repoKey, 'limit');
      return;
    }

    await fs.promises.mkdir(files.dir, { recursive: true, mode: 0o700 });
    await fs.promises.rm(files.refresh, { force: true });
    if (fullBecause) await createSparse(files.refresh, this.options.dataDiskGiB());
    else await cloneFile(files.golden, files.refresh);
    this.log('info', `cache refresh for ${repository}: ${fullBecause ? `from blank (${fullBecause})` : 'incremental'}, loading ${toLoad.length}`);

    const release = store.pin([...images.values()].flatMap(blobsOf));
    let vm: VmHandle | null = null;
    try {
      vm = this.options.startRefreshVm({ repository, repoKey });
      if (vmIdSlot(vm.vmId) !== REFRESH_SLOT || vm.dockerSocketPath !== vmJobFiles(this.options.dataDir, vm.vmId).dockerSocket) {
        throw new Error(`the refresh VM ${vm.vmId} is not a refresh-slot VM of this data directory`);
      }
      await vm.ready();
      const daemon = { socketPath: vm.dockerSocketPath, connect: this.options.connectDaemon };
      const loaded = new Set(fullBecause ? [] : [...held].filter((d) => images.has(d)));
      for (const ref of toLoad) {
        await loadImage(daemon, dockerArchive(await this.archiveOf(store, ref)));
        loaded.add(ref.configDigest);
      }
      for (const image of await listImages(daemon)) {
        if (!loaded.has(image.Id)) {
          await removeImage(daemon, { id: image.Id });
          continue;
        }
        for (const tag of image.RepoTags) await removeImage(daemon, { tag });
      }
      await vm.agent().shutdown();
      const stopped = await vm.stopped();
      if (!stopped.synced) throw new Error(`the refresh VM stopped (${stopped.reason}) without syncing its disk`);
      if ((this.generation.get(repoKey) ?? 0) !== generation) throw new Error('the golden disk was discarded during the refresh');
      await fs.promises.rename(files.refresh, files.golden);
      await this.writeMeta(repoKey, {
        v: 1,
        dataFormat: guest.dataFormat,
        guestVersion: guest.guestVersion,
        configDigests: [...loaded].sort(),
        builtFromBlankAt: fullBecause ? now : meta!.builtFromBlankAt,
        lastRefreshAt: now,
        lastRefreshFailed: false,
      });
      this.pending.delete(repoKey);
      this.log('info', `cache refresh for ${repository}: the golden disk holds ${loaded.size} image${loaded.size === 1 ? '' : 's'}`);
    } catch (error) {
      if (vm) await vm.stop('cache refresh failed').catch(() => undefined);
      await fs.promises.rm(files.refresh, { force: true });
      const previous = (this.generation.get(repoKey) ?? 0) === generation ? await this.readMeta(repoKey) : null;
      await this.writeMeta(repoKey, {
        v: 1,
        dataFormat: previous?.dataFormat ?? guest.dataFormat,
        guestVersion: previous?.guestVersion ?? guest.guestVersion,
        configDigests: previous?.configDigests ?? [],
        builtFromBlankAt: previous?.builtFromBlankAt ?? 0,
        lastRefreshAt: now,
        lastRefreshFailed: true,
      });
      throw error instanceof DaemonError ? new Error(`the refresh VM: ${error.message}`) : error;
    } finally {
      release();
    }
  }

  /** The archive of one stored image; its blobs are checked again as they stream. */
  private async archiveOf(store: ImageStore, ref: StoreRef) {
    const config = await store.readVerified(ref.configDigest, MAX_CONFIG_BYTES);
    if (!config) throw new Error(`the store no longer holds the config of ${ref.ref}`);
    const layers: ArchiveLayer[] = ref.layers.map((layer) => ({
      digest: layer.digest,
      mediaType: layer.mediaType,
      diffId: layer.diffId,
      uncompressedSize: layer.uncompressedSize,
      open: () =>
        fs.createReadStream('', { fd: fs.openSync(store.pathOf(layer.digest), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) }),
    }));
    return { name: `${imageName(ref.ref)}@${ref.manifestDigest}`, config, configDigest: ref.configDigest, layers };
  }
}
