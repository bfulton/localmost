import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cacheFiles, imageStoreDir, repoKeyOf, vmJobFiles } from './paths';
import type { AgentClient, StartRefreshVm, VmHandle, VmStopped } from './types';
import { CacheDisks as VmCacheDisks, CacheDisksOptions, cloneFile } from './cache-disks';
import { ImageStore, StoreRef } from '../docker/puller/image-store';
import { TestDaemon } from '../docker/puller/test-daemon';
import { buildImage, sha256 } from '../docker/puller/test-registry';

// Held so a test can see which program made a clone.
jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: jest.fn(actual.execFile) };
});

const REPOSITORY = 'octo/widgets';
const REPO_KEY = repoKeyOf(REPOSITORY);
const REFRESH_VM = '0-00000000000a';
const GUEST = { guestVersion: '2026.10.0', dataFormat: 1 };
const DAY = 24 * 60 * 60 * 1000;
const GiB = 1024 ** 3;
/** dockerVm.dataDiskGiB in these tests: small, so a golden disk of that size costs nothing to copy off macOS. */
const DISK_BYTES = 1024 * 1024;

let dataDir: string;
let daemon: TestDaemon;
let now: number;
let guest: { guestVersion: string; dataFormat: number };
let conditions: { onBattery: boolean; memoryPressure: 'normal' | 'warn' | 'critical' };
let started: Array<{ repository: string; repoKey: string }>;
/** Resolves when the next refresh VM starts; renewed by each start. */
let vmStarted: Promise<void>;
let markStarted: () => void;
let vmBehaviour: { synced: boolean; readyError?: Error; vmId: string; socket?: string; gate?: Promise<void> };
let shutdowns: number;
let stops: string[];
let disks: CacheDisksOptions;
/** A daemon for a VM on another slot, when a test runs one. */
let otherDaemon: TestDaemon | null;

function armStarted(): void {
  vmStarted = new Promise<void>((resolve) => (markStarted = resolve));
}

beforeEach(async () => {
  dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cache-disks-')));
  daemon = await TestDaemon.start();
  otherDaemon = null;
  now = Date.UTC(2026, 9, 1);
  guest = { ...GUEST };
  conditions = { onBattery: false, memoryPressure: 'normal' };
  started = [];
  armStarted();
  vmBehaviour = { synced: true, vmId: REFRESH_VM };
  shutdowns = 0;
  stops = [];
});

afterEach(async () => {
  await daemon.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const startRefreshVm: StartRefreshVm = (req) => {
  started.push(req);
  const done = markStarted;
  armStarted();
  done();
  const behaviour = { ...vmBehaviour };
  let stoppedResolve: (s: VmStopped) => void = () => undefined;
  const stopped = new Promise<VmStopped>((resolve) => (stoppedResolve = resolve));
  const agent = {
    shutdown: async () => {
      shutdowns++;
      stoppedResolve({ reason: 'guest', synced: behaviour.synced });
    },
  } as unknown as AgentClient;
  const handle: VmHandle = {
    vmId: behaviour.vmId,
    dockerSocketPath: behaviour.socket ?? vmJobFiles(dataDir, behaviour.vmId).dockerSocket,
    state: () => 'ready',
    ready: async () => {
      if (behaviour.gate) await behaviour.gate;
      if (behaviour.readyError) throw behaviour.readyError;
      return { docker: { version: '29.5.3', apiVersion: '1.54' }, rosetta: 'absent', bootMs: 300 };
    },
    agent: () => agent,
    stop: async (reason: string) => {
      stops.push(reason);
      stoppedResolve({ reason: 'requested', synced: false });
    },
    stopped: () => stopped,
  };
  return handle;
};

function cacheDisks(over: Partial<CacheDisksOptions> = {}): VmCacheDisks {
  disks = {
    dataDir,
    startRefreshVm,
    guest: () => guest,
    cacheLimitGiB: () => 20,
    dataDiskGiB: () => DISK_BYTES / GiB,
    conditions: () => conditions,
    debounceMs: 10,
    now: () => now,
    connectDaemon: (socketPath) =>
      socketPath === vmJobFiles(dataDir, REFRESH_VM).dockerSocket || !otherDaemon ? daemon.connect() : otherDaemon.connect(),
    ...over,
  };
  return new VmCacheDisks(disks);
}

const files = () => cacheFiles(dataDir, REPO_KEY);
const store = () => new ImageStore(imageStoreDir(dataDir, REPO_KEY));

/** A public image in the repository's store, as the puller leaves one. */
async function stock(name: string, lastPulled = now, ref = `docker.io/library/${name}:1`): Promise<StoreRef> {
  const image = buildImage();
  const s = store();
  await s.putBytes(image.manifestDigest, image.manifest);
  for (const [digest, bytes] of image.blobs) await s.putBytes(digest, bytes);
  const layerDigest = [...image.blobs.keys()].find((d) => d !== image.configDigest)!;
  const entry: StoreRef = {
    ref,
    platform: 'linux/arm64',
    manifestDigest: image.manifestDigest,
    configDigest: image.configDigest,
    layers: [
      {
        digest: layerDigest,
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
        size: image.blobs.get(layerDigest)!.length,
        diffId: image.diffIds[0],
        uncompressedSize: image.layers[0].length,
      },
    ],
    lastPulled,
  };
  await s.recordRef(entry);
  return entry;
}

/** A golden disk: `marker` at its start, and the size dockerVm.dataDiskGiB gives a refresh disk. */
function writeGolden(marker: string, meta: Record<string, unknown>, size = DISK_BYTES): void {
  fs.mkdirSync(files().dir, { recursive: true });
  fs.writeFileSync(files().golden, marker);
  fs.truncateSync(files().golden, size);
  fs.writeFileSync(files().meta, JSON.stringify({ v: 1, lastRefreshFailed: false, lastRefreshAt: now, ...meta }));
}

/** The first bytes of a disk image, as text. */
function startOf(file: string, length: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, 0);
    return buffer.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

const readMeta = () => JSON.parse(fs.readFileSync(files().meta, 'utf-8'));
const loadedIds = () => daemon.loads.map((l) => l.id).sort();
const validMeta = (over: Record<string, unknown> = {}) => ({
  dataFormat: 1,
  guestVersion: GUEST.guestVersion,
  configDigests: [],
  builtFromBlankAt: now,
  ...over,
});

describe('prepareJobDisk', () => {
  const dest = () => vmJobFiles(dataDir, '4-00000000000b').dataDisk;

  beforeEach(() => {
    fs.mkdirSync(path.dirname(dest()), { recursive: true });
  });

  it('makes a new sparse disk when there is no golden disk', async () => {
    await expect(cacheDisks().prepareJobDisk(REPO_KEY, dest(), 2)).resolves.toBe('blank');
    const stat = fs.statSync(dest());
    expect(stat.size).toBe(2 * GiB);
    expect(stat.blocks * 512).toBeLessThan(1024 * 1024);
  });

  it('clones the golden disk, and the clone is its own file', async () => {
    writeGolden('golden disk bytes', validMeta());
    await expect(cacheDisks().prepareJobDisk(REPO_KEY, dest(), 64)).resolves.toBe('clone');
    expect(startOf(dest(), 17)).toBe('golden disk bytes');
    expect(fs.statSync(dest()).ino).not.toBe(fs.statSync(files().golden).ino);
    fs.writeFileSync(dest(), 'the job wrote this');
    expect(startOf(files().golden, 17)).toBe('golden disk bytes');
  });

  it('discards a golden disk whose dataFormat is not the guest', async () => {
    writeGolden('old format', validMeta({ dataFormat: 0, guestVersion: 'old' }));
    await expect(cacheDisks().prepareJobDisk(REPO_KEY, dest(), 2)).resolves.toBe('blank');
    expect(fs.existsSync(files().golden)).toBe(false);
    expect(fs.existsSync(files().meta)).toBe(false);
  });

  it('does not clone a golden disk with no readable meta.json, or one read through a symlink', async () => {
    writeGolden('no meta', {});
    fs.writeFileSync(files().meta, '{ broken');
    await expect(cacheDisks().prepareJobDisk(REPO_KEY, dest(), 2)).resolves.toBe('blank');
    fs.rmSync(dest());
    const elsewhere = path.join(dataDir, 'meta-elsewhere.json');
    fs.writeFileSync(elsewhere, JSON.stringify({ v: 1, lastRefreshFailed: false, lastRefreshAt: now, ...validMeta() }));
    fs.rmSync(files().meta);
    fs.symlinkSync(elsewhere, files().meta);
    await expect(cacheDisks().prepareJobDisk(REPO_KEY, dest(), 2)).resolves.toBe('blank');
  });

  it('refuses a destination that is not a VM data disk', async () => {
    await expect(cacheDisks().prepareJobDisk(REPO_KEY, path.join(dataDir, 'elsewhere.img'), 2)).rejects.toThrow();
    await expect(cacheDisks().prepareJobDisk('../../x', dest(), 2)).rejects.toThrow();
    // Named like a VM's, but not where VmManager puts one.
    const other = path.join(dataDir, 'other', '4-00000000000b', 'data.img');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    await expect(cacheDisks().prepareJobDisk(REPO_KEY, other, 2)).rejects.toThrow(`not a VM's data disk: ${other}`);
    expect(fs.existsSync(other)).toBe(false);
  });

  it('never overwrites a file already at the destination', async () => {
    fs.writeFileSync(dest(), 'already here');
    await expect(cacheDisks().prepareJobDisk(REPO_KEY, dest(), 2)).rejects.toThrow();
    expect(fs.readFileSync(dest(), 'utf-8')).toBe('already here');
  });
});

describe('cloneFile', () => {
  it('uses clonefile (cp -c) on darwin, and a plain copy elsewhere', async () => {
    const src = path.join(dataDir, 'src.img');
    const dest = path.join(dataDir, 'dest.img');
    fs.writeFileSync(src, Buffer.alloc(4 * 1024 * 1024, 7));
    const copyFile = jest.spyOn(fs.promises, 'copyFile');
    try {
      await cloneFile(src, dest);
      if (process.platform === 'darwin') {
        // Node's copyFile makes a full copy on macOS whatever its flags ask.
        expect(childProcess.execFile).toHaveBeenCalledWith('/bin/cp', ['-c', '-n', src, dest], expect.anything(), expect.anything());
        expect(copyFile).not.toHaveBeenCalled();
      } else {
        expect(process.platform).not.toBe('darwin');
        const mode = copyFile.mock.calls[0][2] as number;
        expect(mode & fs.constants.COPYFILE_EXCL).toBeTruthy();
        expect(mode & fs.constants.COPYFILE_FICLONE).toBeTruthy();
      }
    } finally {
      copyFile.mockRestore();
    }
    expect(fs.statSync(dest).ino).not.toBe(fs.statSync(src).ino);
    expect(fs.readFileSync(dest).equals(fs.readFileSync(src))).toBe(true);
    fs.writeFileSync(dest, 'changed');
    expect(fs.statSync(src).size).toBe(4 * 1024 * 1024);
  });

  it('never replaces a file at the destination', async () => {
    const src = path.join(dataDir, 'src.img');
    const dest = path.join(dataDir, 'dest.img');
    fs.writeFileSync(src, 'source');
    fs.writeFileSync(dest, 'keep');
    await expect(cloneFile(src, dest)).rejects.toThrow();
    expect(fs.readFileSync(dest, 'utf-8')).toBe('keep');
  });

  it('refuses to clone across volumes on darwin, where cp would quietly copy; elsewhere it copies', async () => {
    const src = path.join(dataDir, 'src.img');
    const dest = path.join(dataDir, 'dest.img');
    fs.writeFileSync(src, 'source');
    const realStat = fs.promises.stat.bind(fs.promises);
    // The destination's directory reports another device, as another volume would.
    const stat = jest.spyOn(fs.promises, 'stat').mockImplementation(async (p, options) => {
      const s = await realStat(p as string, options as fs.StatOptions);
      return p === path.dirname(dest) ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { dev: (s.dev as number) + 1 }) : s;
    });
    try {
      if (process.platform === 'darwin') {
        await expect(cloneFile(src, dest)).rejects.toThrow('are on different volumes');
        expect(fs.existsSync(dest)).toBe(false);
      } else {
        expect(process.platform).not.toBe('darwin');
        await cloneFile(src, dest);
        expect(fs.readFileSync(dest, 'utf-8')).toBe('source');
      }
    } finally {
      stat.mockRestore();
    }
  });
});

describe('refreshes', () => {
  it('start through the injected StartRefreshVm, on a slot-0 VM, and are debounced', async () => {
    await stock('alpine');
    // Read once per refresh: five schedules in a row make one refresh.
    const guestRead = jest.fn(() => guest);
    const cd = cacheDisks({ guest: guestRead });
    for (let i = 0; i < 5; i++) cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await cd.settled(REPO_KEY);
    expect(guestRead).toHaveBeenCalledTimes(1);
    expect(started).toEqual([{ repository: REPOSITORY, repoKey: REPO_KEY }]);
    expect(shutdowns).toBe(1);
    expect(fs.existsSync(files().golden)).toBe(true);
    expect(fs.existsSync(files().refresh)).toBe(false);
  });

  it('are not scheduled for a repository that is not the one the key was made from', async () => {
    await stock('alpine');
    const cd = cacheDisks();
    cd.scheduleRefresh(REPO_KEY, 'someone/else');
    await cd.settled(REPO_KEY);
    expect(started).toHaveLength(0);
  });

  it('refuse a VM that is not on the refresh slot', async () => {
    await stock('alpine');
    vmBehaviour.vmId = '5-00000000000c';
    // A daemon that would take the load, so only the slot check stops it.
    otherDaemon = await TestDaemon.start();
    const jobDaemon = otherDaemon;
    const cd = cacheDisks();
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await cd.settled(REPO_KEY);
    await jobDaemon.close();
    expect(jobDaemon.loads).toHaveLength(0);
    expect(stops.length).toBe(1);
    expect(fs.existsSync(files().golden)).toBe(false);
    expect(readMeta().lastRefreshFailed).toBe(true);
  });

  it('refuse a slot-0 VM whose docker.sock is not where VmManager puts one', async () => {
    await stock('alpine');
    vmBehaviour.socket = path.join(dataDir, 'elsewhere', REFRESH_VM, 'docker.sock');
    const cd = cacheDisks();
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await cd.settled(REPO_KEY);
    expect(daemon.calls).toHaveLength(0);
    expect(stops.length).toBe(1);
    expect(fs.existsSync(files().golden)).toBe(false);
    expect(readMeta().lastRefreshFailed).toBe(true);
  });

  it('run one at a time per repository', async () => {
    await stock('alpine');
    let open: () => void = () => undefined;
    vmBehaviour.gate = new Promise<void>((resolve) => (open = resolve));
    const cd = cacheDisks();
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await vmStarted;
    expect(started).toHaveLength(1);
    await stock('busybox');
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await new Promise((r) => setTimeout(r, 50));
    // The second waits for the first.
    expect(started).toHaveLength(1);
    vmBehaviour.gate = undefined;
    open();
    await cd.settled(REPO_KEY);
    expect(started).toHaveLength(2);
    expect(readMeta().configDigests).toHaveLength(2);
  });

  it('wait on battery or under memory pressure, and run once conditions allow', async () => {
    await stock('alpine');
    conditions = { onBattery: true, memoryPressure: 'normal' };
    const cd = cacheDisks();
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await new Promise((r) => setTimeout(r, 60));
    expect(started).toHaveLength(0);
    conditions = { onBattery: false, memoryPressure: 'warn' };
    await new Promise((r) => setTimeout(r, 60));
    expect(started).toHaveLength(0);
    conditions = { onBattery: false, memoryPressure: 'normal' };
    await cd.settled(REPO_KEY);
    expect(started).toHaveLength(1);
  });

  it('run within maxWaitMs of the first schedule, however often they are scheduled again', async () => {
    await stock('alpine');
    const cd = cacheDisks({ debounceMs: 300, maxWaitMs: 150 });
    let ran = false;
    void vmStarted.then(() => (ran = true));
    // Jobs keep finishing every 20 ms, well inside the debounce, for up to 10 s.
    const deadline = Date.now() + 10_000;
    while (!ran && Date.now() < deadline) {
      cd.scheduleRefresh(REPO_KEY, REPOSITORY);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(ran).toBe(true);
    await cd.settled(REPO_KEY);
  });

  it('load only the images missing from meta.json, and remove everything else', async () => {
    const kept = await stock('alpine');
    const added = await stock('busybox');
    writeGolden('golden', validMeta({ configDigests: [kept.configDigest], builtFromBlankAt: now - DAY }));
    // What the cloned golden disk holds: the kept image, a stray image and a tag.
    daemon.images.set(kept.configDigest, ['docker.io/library/alpine:1']);
    daemon.images.set(`sha256:${'e'.repeat(64)}`, []);
    const cd = cacheDisks();
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await cd.settled(REPO_KEY);
    expect(loadedIds()).toEqual([added.configDigest]);
    expect([...daemon.images.keys()].sort()).toEqual([kept.configDigest, added.configDigest].sort());
    expect(daemon.images.get(kept.configDigest)).toEqual([]);
    // Incremental: the new golden disk started as a clone of the old one.
    expect(startOf(files().golden, 6)).toBe('golden');
    const meta = readMeta();
    expect(meta.configDigests.sort()).toEqual([kept.configDigest, added.configDigest].sort());
    expect(meta.builtFromBlankAt).toBe(now - DAY);
    expect(meta.lastRefreshFailed).toBe(false);
  });

  it('name each image in its archive by the reference it was pulled by', async () => {
    const byTag = await stock('alpine');
    const digest = sha256(Buffer.from('an index'));
    const byDigest = await stock('busybox', now, `docker.io/library/busybox@${digest}`);
    const cd = cacheDisks();
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await cd.settled(REPO_KEY);
    const names = new Map(
      daemon.loads.map((l) => [l.id, JSON.parse(l.entries.get('index.json')!.toString()).manifests[0].annotations['io.containerd.image.name']])
    );
    expect(names.get(byTag.configDigest)).toBe(`docker.io/library/alpine@${byTag.manifestDigest}`);
    expect(names.get(byDigest.configDigest)).toBe(`docker.io/library/busybox@${digest}`);
  });

  it('start no VM when the golden disk already holds everything', async () => {
    const kept = await stock('alpine');
    writeGolden('golden', validMeta({ configDigests: [kept.configDigest] }));
    const cd = cacheDisks();
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await cd.settled(REPO_KEY);
    expect(started).toHaveLength(0);
  });

  it.each([
    ['the guest version changed', { guestVersion: '2026.09.0', builtFromBlankAt: Date.UTC(2026, 9, 1) }, DISK_BYTES],
    ['the golden disk was last built from blank over 7 days ago', { builtFromBlankAt: Date.UTC(2026, 9, 1) - 8 * DAY }, DISK_BYTES],
    ['the previous refresh failed', { lastRefreshFailed: true, builtFromBlankAt: Date.UTC(2026, 9, 1) }, DISK_BYTES],
    ['dockerVm.dataDiskGiB was lowered below the golden disk', { builtFromBlankAt: Date.UTC(2026, 9, 1) }, 2 * DISK_BYTES],
    ['dockerVm.dataDiskGiB was raised past the golden disk', { builtFromBlankAt: Date.UTC(2026, 9, 1) }, DISK_BYTES / 2],
  ])('start from a blank disk and load everything when %s', async (_why, meta, goldenSize) => {
    const kept = await stock('alpine');
    const added = await stock('busybox');
    writeGolden('golden', { ...validMeta({ configDigests: [kept.configDigest] }), ...meta }, goldenSize);
    const cd = cacheDisks();
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await cd.settled(REPO_KEY);
    expect(loadedIds()).toEqual([kept.configDigest, added.configDigest].sort());
    expect(startOf(files().golden, 6)).not.toBe('golden');
    expect(fs.statSync(files().golden).size).toBe(DISK_BYTES);
    expect(readMeta().builtFromBlankAt).toBe(now);
    expect(readMeta().guestVersion).toBe(GUEST.guestVersion);
  });

  it('delete .new on a failure and make the next refresh full', async () => {
    const kept = await stock('alpine');
    writeGolden('golden', validMeta({ configDigests: [kept.configDigest] }));
    await stock('busybox');
    vmBehaviour.readyError = Object.assign(new Error('agent did not answer'), { stage: 'agent', code: 'E_TIMEOUT' });
    const cd = cacheDisks();
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await cd.settled(REPO_KEY);
    expect(fs.existsSync(files().refresh)).toBe(false);
    expect(startOf(files().golden, 6)).toBe('golden');
    expect(readMeta().lastRefreshFailed).toBe(true);
    expect(stops).toHaveLength(1);

    vmBehaviour.readyError = undefined;
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await cd.settled(REPO_KEY);
    expect(loadedIds()).toHaveLength(2);
    expect(readMeta().lastRefreshFailed).toBe(false);
    expect(readMeta().builtFromBlankAt).toBe(now);
  });

  it('never promote a disk the helper did not sync', async () => {
    await stock('alpine');
    writeGolden('golden', validMeta());
    vmBehaviour.synced = false;
    const cd = cacheDisks();
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await cd.settled(REPO_KEY);
    expect(startOf(files().golden, 6)).toBe('golden');
    expect(fs.existsSync(files().refresh)).toBe(false);
    expect(readMeta().lastRefreshFailed).toBe(true);
  });

  it.each([
    ['a load answer naming another image', () => (daemon.switches.loadedId = sha256(Buffer.from('another')))],
    ['an oversized image list', () => (daemon.switches.oversize = 'list')],
    [
      // An image that is not kept goes by its id; a kept one has its tags removed by name.
      'a tag on a kept image that no image name can be',
      (kept: StoreRef) => daemon.images.set(kept.configDigest, ['docker.io/library/x/../../containers/y:1']),
    ],
  ])('fail, and promote nothing, on %s', async (_what, arrange: (kept: StoreRef) => unknown) => {
    const kept = await stock('alpine');
    writeGolden('golden', validMeta());
    arrange(kept);
    const cd = cacheDisks();
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await cd.settled(REPO_KEY);
    expect(startOf(files().golden, 6)).toBe('golden');
    expect(fs.existsSync(files().refresh)).toBe(false);
    expect(readMeta().lastRefreshFailed).toBe(true);
    expect(daemon.calls.filter((c) => c.method === 'DELETE' && c.path.includes('..'))).toHaveLength(0);
  });

  it('leave no temporary meta.json behind when writing it fails', async () => {
    await stock('alpine');
    const realRename = fs.promises.rename.bind(fs.promises);
    const rename = jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (to === files().meta) throw new Error('disk full');
      return realRename(from, to);
    });
    try {
      const cd = cacheDisks();
      cd.scheduleRefresh(REPO_KEY, REPOSITORY);
      await cd.settled(REPO_KEY);
    } finally {
      rename.mockRestore();
    }
    expect(fs.readdirSync(files().dir).filter((f) => f.startsWith('meta.json'))).toEqual([]);
  });

  it('drop the least recently pulled images past cacheLimitGiB and rebuild from blank', async () => {
    const old = await stock('old', now - 3 * DAY);
    const recent = await stock('recent', now - DAY);
    writeGolden('golden', validMeta({ configDigests: [old.configDigest, recent.configDigest] }));
    // Room for one of the two small images, not both.
    const one = (await store().usage()) / 2 + old.layers[0].uncompressedSize + 1024;
    const cd = cacheDisks({ cacheLimitGiB: () => one / GiB });
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await cd.settled(REPO_KEY);
    expect(loadedIds()).toEqual([recent.configDigest]);
    expect(readMeta().configDigests).toEqual([recent.configDigest]);
    expect((await store().readRefs()).map((r) => r.ref)).toEqual([recent.ref]);
  });

  it('discard(): the golden disk and meta.json go, and a refresh under way is not promoted', async () => {
    await stock('alpine');
    let open: () => void = () => undefined;
    vmBehaviour.gate = new Promise<void>((resolve) => (open = resolve));
    const cd = cacheDisks();
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await vmStarted;
    await cd.discard(REPO_KEY, 'corrupt');
    open();
    await cd.settled(REPO_KEY);
    expect(fs.existsSync(files().golden)).toBe(false);
    expect(fs.existsSync(files().refresh)).toBe(false);
  });
});

describe('a refresh that stops answering', () => {
  it('is stopped at its deadline, fails, and leaves the repository free to refresh again', async () => {
    await stock('alpine');
    writeGolden('golden', validMeta());
    // A VM that never becomes ready.
    vmBehaviour.gate = new Promise<void>(() => undefined);
    const cd = cacheDisks({ refreshTimeoutMs: 200 });
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await cd.settled(REPO_KEY);
    expect(stops).toHaveLength(1);
    expect(fs.existsSync(files().refresh)).toBe(false);
    expect(startOf(files().golden, 6)).toBe('golden');
    expect(readMeta().lastRefreshFailed).toBe(true);

    vmBehaviour.gate = undefined;
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await cd.settled(REPO_KEY);
    expect(started).toHaveLength(2);
    expect(readMeta().lastRefreshFailed).toBe(false);
  });

  it.each(['load', 'list'] as const)('is stopped at its deadline when the daemon never answers the %s', async (which) => {
    await stock('alpine');
    daemon.switches.hang = which;
    const cd = cacheDisks({ refreshTimeoutMs: 300 });
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await cd.settled(REPO_KEY);
    expect(stops).toHaveLength(1);
    expect(fs.existsSync(files().golden)).toBe(false);
    expect(readMeta().lastRefreshFailed).toBe(true);
  });
});

describe('shutdown()', () => {
  it('stops a running refresh, cancels a scheduled one, and schedules nothing after', async () => {
    await stock('alpine');
    vmBehaviour.gate = new Promise<void>(() => undefined);
    const cd = cacheDisks();
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await vmStarted;
    const other = repoKeyOf('octo/other');
    cd.scheduleRefresh(other, 'octo/other');
    await cd.shutdown();
    expect(stops).toHaveLength(1);
    expect(readMeta().lastRefreshFailed).toBe(true);
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    // Nothing was scheduled, so nothing is pending.
    await cd.settled(REPO_KEY);
    await cd.settled(other);
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toHaveLength(1);
  });

  it('does not wait for a refresh held back on battery', async () => {
    await stock('alpine');
    conditions = { onBattery: true, memoryPressure: 'normal' };
    const cd = cacheDisks();
    cd.scheduleRefresh(REPO_KEY, REPOSITORY);
    await new Promise((r) => setTimeout(r, 30));
    await cd.shutdown();
    await cd.settled(REPO_KEY);
    conditions = { onBattery: false, memoryPressure: 'normal' };
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toHaveLength(0);
  });
});
