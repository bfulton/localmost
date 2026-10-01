/**
 * ImagePuller (contract §6.4): a job's pull, done on the Mac and loaded into
 * the job's VM, so that registry credentials never enter the VM.
 *
 * 1. Resolve the reference: a manifest HEAD for a tag (Docker Hub does not
 *    count it against the pull limit), then the index or manifest from the
 *    store when the store has what the HEAD named, otherwise from the
 *    registry, identified by the hash of its bytes. Choose the platform.
 * 2. If the VM already has the image (its id is the config digest), skip
 *    to the tag: a cache-disk hit.
 * 3. Fetch the blobs the store lacks, each verified as it streams: the
 *    compressed bytes against the descriptor, the uncompressed bytes
 *    against the config's diff_id, within the byte limits.
 * 4. Load a docker-save archive of the image into the VM. A stored layer
 *    that fails its check again is deleted and fetched once more.
 * 5. Tag it with the name the job asked for. A pull by digest leaves the
 *    image untagged: dockerd's classic store finds it only by its id, the
 *    config digest this returns (§5.3 has the filter map the reference).
 * 6. For a public image only, record it in refs.json for the repository's
 *    cache disk.
 *
 * "Public" is owner decision 1 (§6.3 "Which store"): an image whose manifest
 * or config was read from the job's own store never is, and whenever the pull
 * holds the operator's credentials the image is public only if the registry
 * also serves its manifest anonymously, bytes and all. Otherwise its blobs go
 * to the job's own store, in the VM's directory, and go with the VM.
 *
 * Every pull runs in Electron main, so one VM runs at most three at once and
 * all VMs together eight; the rest wait their turn.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PassThrough, Transform } from 'stream';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import type { DockerProgress } from '../docker-backend';
import { imageStoreDir, repoKeyOf, VM_ID_RE, vmJobFiles } from '../../vm/paths';
import type { CacheDisks, ImagePuller, ImagePullOptions, ImagePullResult, RosettaState } from '../../vm/types';
import { cleanText } from './clean-text';
import { DaemonConnector, hasImage, loadImage, tagImage } from './daemon-api';
import { dockerArchive, measureLayer, ArchiveLayer, LayerVerifyError } from './docker-archive';
import { DigestMismatchError, ImageStore, StoreLayer } from './image-store';
import {
  checkDigest,
  ContentDescriptor,
  isTag,
  LAYER_TYPES,
  MAX_MANIFEST_BYTES,
  normalizeRepositoryPath,
  parseConfig,
  parseManifest,
  PlatformDescriptor,
  PullError,
  registryOrigin,
  RegistryClient,
  RegistrySession,
} from './registry-client';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
/** A layer may expand to 64 MiB plus 100 times its compressed size (§6.3). */
const EXPANSION_BASE = 64 * MiB;
const EXPANSION_RATIO = 100;
/** And to no more than this many times pullMaxGiB. */
const EXPANSION_PULL_FACTOR = 4;
const FREE_SPACE_CHECK_BYTES = 256 * MiB;
const MAX_CONFIG_BYTES = 16 * MiB;
/** How often, in bytes, a layer's download reports progress. */
const PROGRESS_STEP = 512 * 1024;
/** At most this many jobs' pull totals, and VM stores' sweeps, are remembered. */
const MAX_JOBS_TRACKED = 512;
/**
 * Pulls run in Electron main, which every job shares, and each holds a
 * decompressor (zstd's window can reach 128 MiB), its manifests and its
 * config in memory. So one VM runs this many at once, and all VMs together
 * DEFAULT_MAX_PULLS; the rest wait their turn.
 */
const DEFAULT_MAX_PULLS_PER_VM = 3;
const DEFAULT_MAX_PULLS = 8;

export interface PullLimits {
  pullMaxGiB: number;
  jobPullMaxGiB: number;
  minFreeGiB: number;
}

export interface ImagePullerOptions {
  /** `<data>`, realpathed. */
  dataDir: string;
  client: RegistryClient;
  cacheDisks: Pick<CacheDisks, 'notePulled'>;
  /** Read at each pull, so a config change applies to the next one. */
  limits: () => PullLimits;
  /** Free space on `<data>`'s volume. Defaults to fs.promises.statfs. */
  statfs?: (dir: string) => Promise<{ bavail: number; bsize: number }>;
  /** Bytes fetched between free-space checks while a pull streams (256 MiB). */
  freeSpaceCheckBytes?: number;
  /** Tests only: how to reach a VM's docker.sock (see DaemonConnector). */
  connectDaemon?: DaemonConnector;
  /** Pulls one VM runs at once; more wait their turn. */
  maxPullsPerVm?: number;
  /** Pulls every VM together runs at once. */
  maxPulls?: number;
  now?: () => number;
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
}

export interface RequestedPlatform {
  architecture: 'arm64' | 'amd64';
  variant?: string;
}

/** A request's `?platform=`: linux/arm64 or linux/amd64, with an optional variant. */
export function parsePlatformRequest(platform: string | undefined): RequestedPlatform | undefined {
  if (platform === undefined || platform === '') return undefined;
  const match = /^linux\/(arm64|amd64)(?:\/(v[0-9]))?$/.exec(platform.toLowerCase());
  if (!match) {
    throw new PullError(`localmost's Docker VM runs linux/arm64 and linux/amd64 images, not ${cleanText(platform, 100)}`);
  }
  return { architecture: match[1] as 'arm64' | 'amd64', ...(match[2] ? { variant: match[2] } : {}) };
}

function rosettaRefusal(ref: string, rosetta: RosettaState, asked: boolean): PullError {
  const why = asked ? `was asked for as linux/amd64` : 'has no arm64 build';
  const state =
    rosetta === 'broken'
      ? "which failed its self-test in this job's Docker VM"
      : 'which is not installed on this Mac (install it with `softwareupdate --install-rosetta`)';
  return new PullError(`image \`${ref}\` ${why}, and amd64 images need Rosetta for Linux, ${state}`);
}

function platformString(architecture: string, variant?: string): string {
  return architecture === 'arm64' && variant ? `linux/arm64/${variant}` : `linux/${architecture}`;
}

/**
 * The index entry to pull (§6.2): linux/arm64, v8 first; linux/amd64 when
 * there is no arm64 or it was asked for, and only when Rosetta works.
 */
export function choosePlatform(
  manifests: PlatformDescriptor[],
  requested: RequestedPlatform | undefined,
  rosetta: RosettaState,
  ref: string
): { descriptor: PlatformDescriptor; platform: string } {
  const linux = manifests.filter((m) => m.platform?.os === 'linux');
  const rank = (m: PlatformDescriptor) => (m.platform?.variant === 'v8' ? 0 : m.platform?.variant === undefined ? 1 : 2);
  const of = (architecture: string) =>
    linux.filter((m) => m.platform?.architecture === architecture).sort((a, b) => rank(a) - rank(b));
  const arm64 = requested?.variant ? of('arm64').filter((m) => m.platform?.variant === requested.variant) : of('arm64');
  const amd64 = of('amd64');
  let chosen: PlatformDescriptor | undefined;
  if (requested?.architecture === 'arm64') {
    chosen = arm64[0];
    if (!chosen) throw new PullError(`image \`${ref}\` has no linux/arm64 build`);
  } else if (requested?.architecture === 'amd64') {
    chosen = amd64[0];
    if (!chosen) throw new PullError(`image \`${ref}\` has no linux/amd64 build`);
  } else {
    chosen = arm64[0] ?? amd64[0];
    if (!chosen) throw new PullError(`image \`${ref}\` has no linux/arm64 or linux/amd64 build`);
  }
  const architecture = chosen.platform!.architecture;
  if (architecture === 'amd64' && rosetta !== 'ok') throw rosettaRefusal(ref, rosetta, requested !== undefined);
  return { descriptor: chosen, platform: platformString(architecture, chosen.platform?.variant) };
}

/** Docker's pull progress bar: `[=====>      ]  1.2MB/3.4MB`. */
function progressBar(current: number, total: number): string {
  const width = 50;
  const filled = total > 0 ? Math.min(width, Math.floor((current / total) * width)) : 0;
  const bar = filled >= width ? '='.repeat(width) : `${'='.repeat(Math.max(0, filled - 1))}${filled > 0 ? '>' : ''}`.padEnd(width, ' ');
  const human = (n: number) => {
    const units = ['B', 'kB', 'MB', 'GB'];
    let value = n;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
      value /= 1000;
      unit++;
    }
    return `${unit === 0 ? value : value.toFixed(value < 10 ? 3 : value < 100 ? 2 : 1)}${units[unit]}`;
  };
  return `[${bar}] ${human(current).padStart(8)}/${human(total)}`;
}

function gib(n: number): string {
  return `${Number(n.toPrecision(6))}`;
}

/** Bytes one pull, and one job, may still fetch. */
class Budget {
  private pulled = 0;

  constructor(
    private readonly limits: PullLimits,
    private readonly job: { pulled: number },
    private readonly ref: string
  ) {}

  private remaining(): number {
    return Math.min(this.limits.pullMaxGiB * GiB - this.pulled, this.limits.jobPullMaxGiB * GiB - this.job.pulled);
  }

  private refuse(): PullError {
    return this.limits.pullMaxGiB * GiB - this.pulled <= this.limits.jobPullMaxGiB * GiB - this.job.pulled
      ? new PullError(`the pull of ${this.ref} would fetch more than ${gib(this.limits.pullMaxGiB)} GiB (dockerVm.pullMaxGiB)`)
      : new PullError(`this job's pulls would fetch more than ${gib(this.limits.jobPullMaxGiB)} GiB (dockerVm.jobPullMaxGiB)`);
  }

  /** Before a fetch: refuse one whose declared size is more than is left. */
  reserve(size: number): void {
    if (size > this.remaining()) throw this.refuse();
  }

  /** As bytes arrive; `attempt` counts what one transfer took. */
  take(bytes: number, attempt: { bytes: number }): void {
    if (bytes > this.remaining()) throw this.refuse();
    this.pulled += bytes;
    this.job.pulled += bytes;
    attempt.bytes += bytes;
  }

  /** Give back what a broken transfer took, before it is retried: none of it was kept. */
  refund(attempt: { bytes: number }): void {
    this.pulled -= attempt.bytes;
    this.job.pulled -= attempt.bytes;
    attempt.bytes = 0;
  }
}

/** A place in line for pulls: so many per VM, so many in all, first come first served. */
class PullSlots {
  private total = 0;
  private readonly perVm = new Map<string, number>();
  private readonly waiting: Array<{ vm: string; start: () => void }> = [];

  constructor(
    private readonly maxPerVm: number,
    private readonly max: number
  ) {}

  private free(vm: string): boolean {
    return this.total < this.max && (this.perVm.get(vm) ?? 0) < this.maxPerVm;
  }

  private take(vm: string): () => void {
    this.total++;
    this.perVm.set(vm, (this.perVm.get(vm) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const count = (this.perVm.get(vm) ?? 1) - 1;
      if (count <= 0) this.perVm.delete(vm);
      else this.perVm.set(vm, count);
      this.next();
    };
  }

  private next(): void {
    for (let i = 0; i < this.waiting.length; ) {
      if (this.free(this.waiting[i].vm)) this.waiting.splice(i, 1)[0].start();
      else i++;
    }
  }

  /** Resolves with the release once the pull may run; a cancelled wait gives up its place. */
  acquire(vm: string, signal: AbortSignal): Promise<() => void> {
    if (this.waiting.length === 0 && this.free(vm)) return Promise.resolve(this.take(vm));
    return new Promise((resolve, reject) => {
      const entry = {
        vm,
        start: () => {
          signal.removeEventListener('abort', cancel);
          resolve(this.take(vm));
        },
      };
      const cancel = () => {
        const at = this.waiting.indexOf(entry);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(new PullError('the pull was cancelled'));
      };
      signal.addEventListener('abort', cancel, { once: true });
      this.waiting.push(entry);
    });
  }
}

interface ResolvedImage {
  /** The digest the reference named: an index or a manifest. */
  topDigest: string;
  topBytes: Buffer;
  indexDigest?: string;
  manifestDigest: string;
  manifestBytes: Buffer;
  config: ContentDescriptor;
  layers: ContentDescriptor[];
  /** Filled in once the config is read, for a single-platform manifest. */
  platform?: string;
  requested?: RequestedPlatform;
  /** Whether the index or the manifest was read from the job's own store. */
  fromJobStore: boolean;
}

/**
 * What a failed transfer is reported as: a cancellation when the job's
 * request went away, the error itself when it was a verdict (a refusal, a
 * mismatch), and otherwise a broken transfer, which is retried once.
 */
function transferError(error: unknown, signal: AbortSignal, what: string): Error {
  if (signal.aborted) return new PullError('the pull was cancelled');
  if (error instanceof PullError || error instanceof DigestMismatchError || error instanceof LayerVerifyError) return error;
  return new PullError(`the transfer of ${what} broke off: ${cleanText((error as Error)?.message ?? String(error), 200)}`, true);
}

/** Until a stream wants more, or is gone; its listeners are removed either way. */
function drained(stream: Transform): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      stream.off('drain', done);
      stream.off('close', done);
      resolve();
    };
    stream.on('drain', done);
    stream.on('close', done);
  });
}

function decompressorFor(mediaType: string): Transform {
  const compression = LAYER_TYPES.get(mediaType);
  if (compression === 'gzip') return zlib.createGunzip();
  if (compression === 'zstd') return zlib.createZstdDecompress();
  return new PassThrough();
}

export class VmImagePuller implements ImagePuller {
  private readonly jobs = new Map<string, { pulled: number }>();
  /** Each store's first sweep, which every pull on it waits for: repository stores, and (bounded) VM stores. */
  private readonly repositorySweeps = new Map<string, Promise<void>>();
  private readonly vmSweeps = new Map<string, Promise<void>>();
  private readonly slots: PullSlots;
  private readonly now: () => number;
  private readonly log: (level: 'debug' | 'info' | 'warn', message: string) => void;

  constructor(private readonly options: ImagePullerOptions) {
    if (!path.isAbsolute(options.dataDir)) throw new Error('the puller needs an absolute data directory');
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.slots = new PullSlots(options.maxPullsPerVm ?? DEFAULT_MAX_PULLS_PER_VM, options.maxPulls ?? DEFAULT_MAX_PULLS);
  }

  /** The VM's own directory, from its docker.sock, which must be exactly where VmManager puts one. */
  private vmDirOf(socketPath: string): string {
    const dir = path.dirname(socketPath);
    const vmId = path.basename(dir);
    if (!VM_ID_RE.test(vmId) || vmJobFiles(this.options.dataDir, vmId).dockerSocket !== socketPath) {
      throw new Error(`not a VM's docker socket: ${socketPath}`);
    }
    return dir;
  }

  private jobTotal(vmDir: string): { pulled: number } {
    let job = this.jobs.get(vmDir);
    if (!job) {
      job = { pulled: 0 };
      this.jobs.set(vmDir, job);
      if (this.jobs.size > MAX_JOBS_TRACKED) this.jobs.delete(this.jobs.keys().next().value!);
    }
    return job;
  }

  /**
   * A store, once the first sweep of what earlier runs left behind is done.
   * Every pull waits for that one sweep, so that it cannot delete what a
   * pull running beside it is writing.
   */
  private async store(root: string, kind: 'repository' | 'vm'): Promise<ImageStore> {
    const store = new ImageStore(root, (message) => this.log('warn', message));
    const sweeps = kind === 'repository' ? this.repositorySweeps : this.vmSweeps;
    let sweep = sweeps.get(root);
    if (!sweep) {
      sweep = store.sweepTemp().catch((error: Error) => this.log('warn', `could not sweep ${root}: ${error.message}`));
      sweeps.set(root, sweep);
      // A VM's store goes with the VM; forget the oldest.
      if (kind === 'vm' && sweeps.size > MAX_JOBS_TRACKED) sweeps.delete(sweeps.keys().next().value!);
    }
    await sweep;
    return store;
  }

  private async checkFreeSpace(minFreeGiB: number): Promise<void> {
    const statfs = this.options.statfs ?? ((dir: string) => fs.promises.statfs(dir));
    const stat = await statfs(this.options.dataDir);
    const free = stat.bavail * stat.bsize;
    if (free < minFreeGiB * GiB) {
      throw new PullError(
        `only ${gib(Math.floor((free / GiB) * 10) / 10)} GiB is free on the disk that holds localmost's data, under dockerVm.minFreeGiB (${gib(minFreeGiB)} GiB)`
      );
    }
  }

  async pull(opts: ImagePullOptions): Promise<ImagePullResult> {
    opts.signal.throwIfAborted();
    const vmDir = this.vmDirOf(opts.dockerSocketPath);
    const release = await this.slots.acquire(vmDir, opts.signal);
    try {
      return await this.pullNow(opts, vmDir);
    } finally {
      release();
    }
  }

  private async pullNow(opts: ImagePullOptions, vmDir: string): Promise<ImagePullResult> {
    const { request, signal } = opts;
    signal.throwIfAborted();
    const daemon = { socketPath: opts.dockerSocketPath, connect: this.options.connectDaemon };
    const limits = this.options.limits();
    registryOrigin(request.registry);
    const repositoryPath = normalizeRepositoryPath(request.registry, request.repositoryPath);
    const registry = request.registry.toLowerCase();
    const name = `${registry}/${repositoryPath}`;
    const tag = request.digest ? undefined : (request.tag || 'latest');
    if (tag !== undefined && !isTag(tag)) throw new PullError(`\`${cleanText(tag, 200)}\` is not a tag`);
    if (request.digest !== undefined) checkDigest(request.digest, `${name}@${cleanText(request.digest, 100)}`);
    const reference = request.digest ?? tag!;
    const ref = request.digest ? `${name}@${request.digest}` : `${name}:${tag}`;
    const requested = parsePlatformRequest(request.platform);
    const repoKey = repoKeyOf(opts.repository);

    await this.checkFreeSpace(limits.minFreeGiB);
    const publicStore = await this.store(imageStoreDir(this.options.dataDir, repoKey), 'repository');
    const jobStore = await this.store(vmJobFiles(this.options.dataDir, path.basename(vmDir)).blobStore, 'vm');
    const progress = (p: DockerProgress) => opts.onProgress(p);
    progress({ status: `Pulling from ${repositoryPath}`, id: tag ?? request.digest! });

    const session = await this.options.client.open({ registry, repositoryPath }, 'operator', signal);
    const resolved = await this.resolve(session, publicStore, jobStore, reference, ref, requested, opts.rosetta);

    // The config: from a store, or fetched (small, in memory, verified).
    const budget = new Budget(limits, this.jobTotal(vmDir), ref);
    const config = await this.smallBlob(session, [publicStore, jobStore], resolved.config, MAX_CONFIG_BYTES, budget, ref, signal);
    const imageConfig = parseConfig(config.bytes, resolved.layers.length, ref);
    const platform = this.checkConfigPlatform(resolved, imageConfig, opts.rosetta, ref);

    // Which store (owner decision 1, §6.3). Never public when the manifest
    // or the config came from the job's own store: only a private pull puts
    // them there, and the job store answers for any registry and repository
    // that names their digest, so a second pull through another one could
    // otherwise carry a private config into the shared store. Otherwise
    // public only when the registry serves the manifest anonymously, asked
    // whenever the answer could be no: whenever the session holds the
    // operator's credentials, sent yet or not (a manifest and config read
    // from the public store send nothing, and the layers would then be
    // fetched with them). A pull with neither fetched everything anonymously.
    const fromJobStore = resolved.fromJobStore || config.from === jobStore;
    const mustAsk = session.hasCredentials || session.usedCredentials;
    let isPublic = !fromJobStore;
    if (isPublic && mustAsk) {
      try {
        const anonymous = await this.options.client.open({ registry, repositoryPath }, 'anonymous', signal);
        isPublic = await anonymous.serves(resolved.manifestDigest);
      } catch (error) {
        if (signal.aborted) throw new PullError('the pull was cancelled');
        this.log('debug', `anonymous check of ${ref} failed, so it is kept for this job only: ${(error as Error).message}`);
        isPublic = false;
      }
    }
    const target = isPublic ? publicStore : jobStore;
    const sources = isPublic ? [publicStore] : [jobStore, publicStore];

    const layerIds = resolved.layers.map((l) => l.digest.slice(7, 19));
    const release = [publicStore.pin(this.blobsFor(resolved)), jobStore.pin(this.blobsFor(resolved))];
    try {
      let source: ImagePullResult['source'];
      if (await hasImage(daemon, resolved.config.digest, signal)) {
        source = 'vm';
        for (const id of layerIds) progress({ status: 'Already exists', id });
      } else {
        const known = await this.knownSizes(publicStore, resolved.manifestDigest);
        let layers: ArchiveLayer[] = [];
        let fetched = false;
        // A stored layer that fails its check again (as it is measured, or as
        // the archive streams) is deleted from both stores, and the pull runs
        // once more, which fetches it from the registry (§6.3).
        for (let attempt = 0; ; attempt++) {
          try {
            layers = [];
            for (const [i, layer] of resolved.layers.entries()) {
              const id = layerIds[i];
              const diffId = imageConfig.diffIds[i];
              const holder = await this.holderOf(sources, layer.digest);
              let uncompressedSize: number;
              let store: ImageStore;
              if (holder) {
                progress({ status: 'Already exists', id });
                store = holder;
                uncompressedSize =
                  known.get(layer.digest) ??
                  (await measureLayer(this.archiveSource(store, layer, diffId), this.expansionLimit(layer.size, limits)));
              } else {
                progress({ status: 'Pulling fs layer', id });
                uncompressedSize = await this.fetchLayer(session, target, layer, diffId, budget, limits, ref, id, progress, signal);
                store = target;
                fetched = true;
              }
              layers.push({ ...this.archiveSource(store, layer, diffId), uncompressedSize });
            }
            signal.throwIfAborted();
            const loaded = await loadImage(
              daemon,
              dockerArchive({ name: `${name}@${resolved.topDigest}`, config: config.bytes, configDigest: resolved.config.digest, layers }),
              signal
            );
            if (loaded.some((id) => id !== resolved.config.digest)) {
              throw new PullError(`the Docker VM loaded ${cleanText(loaded.join(', '), 200)} for ${ref}, not ${resolved.config.digest}`);
            }
            break;
          } catch (error) {
            if (!(error instanceof LayerVerifyError)) throw error;
            await publicStore.remove(error.digest).catch(() => undefined);
            await jobStore.remove(error.digest).catch(() => undefined);
            known.delete(error.digest);
            if (attempt > 0 || signal.aborted) throw error;
            this.log('warn', `${error.message}; deleted, and fetched again`);
          }
        }
        source = fetched ? 'registry' : 'store';
        if (!(await hasImage(daemon, resolved.config.digest, signal))) {
          throw new PullError(`the Docker VM does not show ${resolved.config.digest} after loading ${ref}`);
        }
        for (const id of layerIds) progress({ status: 'Pull complete', id });
        await this.keep(target, resolved, config);
        if (isPublic) {
          await publicStore.recordRef({
            ref,
            platform,
            manifestDigest: resolved.manifestDigest,
            configDigest: resolved.config.digest,
            ...(resolved.indexDigest ? { indexDigest: resolved.indexDigest } : {}),
            layers: resolved.layers.map((l, i): StoreLayer => ({
              digest: l.digest,
              mediaType: l.mediaType,
              size: l.size,
              diffId: imageConfig.diffIds[i],
              uncompressedSize: layers[i].uncompressedSize,
            })),
            lastPulled: this.now(),
          });
        }
      }
      if (source === 'vm' && isPublic) await this.touch(publicStore, ref, platform, resolved.manifestDigest);
      if (tag !== undefined) await tagImage(daemon, resolved.config.digest, name, tag, signal);
      if (isPublic) this.options.cacheDisks.notePulled(repoKey, resolved.config.digest);
      progress({ status: `Digest: ${resolved.topDigest}` });
      progress({
        status: source === 'vm' ? `Status: Image is up to date for ${ref}` : `Status: Downloaded newer image for ${ref}`,
      });
      return { manifestDigest: resolved.manifestDigest, configDigest: resolved.config.digest, platform, source };
    } finally {
      for (const done of release) done();
    }
  }

  private blobsFor(resolved: ResolvedImage): string[] {
    return [resolved.topDigest, resolved.manifestDigest, resolved.config.digest, ...resolved.layers.map((l) => l.digest)];
  }

  private async holderOf(stores: ImageStore[], digest: string): Promise<ImageStore | null> {
    for (const store of stores) if (await store.has(digest)) return store;
    return null;
  }

  /** A small blob from the first store that holds it, verified, and which store that was. */
  private async fromStores(stores: ImageStore[], digest: string, max: number): Promise<{ bytes: Buffer; from: ImageStore } | null> {
    for (const store of stores) {
      const bytes = await store.readVerified(digest, max);
      if (bytes) return { bytes, from: store };
    }
    return null;
  }

  /** Step 1: the index or manifest the reference names, and the platform's manifest under it. */
  private async resolve(
    session: RegistrySession,
    publicStore: ImageStore,
    jobStore: ImageStore,
    reference: string,
    ref: string,
    requested: RequestedPlatform | undefined,
    rosetta: RosettaState
  ): Promise<ResolvedImage> {
    const stores = [publicStore, jobStore];
    let fromJobStore = false;
    let top: { digest: string; bytes: Buffer; mediaType?: string } | null = null;
    // A tag is resolved with a HEAD; any stored blob with the digest it
    // names is that manifest, since the store is content-addressed.
    const digest = reference.startsWith('sha256:') ? reference : await this.headDigest(session, reference, ref);
    if (digest !== undefined) {
      const stored = await this.fromStores(stores, digest, MAX_MANIFEST_BYTES);
      if (stored) {
        top = { digest, bytes: stored.bytes };
        fromJobStore ||= stored.from === jobStore;
      }
    }
    if (!top) {
      const fetched = await session.manifest(reference);
      if (reference.startsWith('sha256:') && fetched.digest !== reference) {
        throw new PullError(`the registry sent a manifest for ${ref} whose digest is ${fetched.digest}, not ${reference}`);
      }
      top = { digest: fetched.digest, bytes: fetched.bytes, mediaType: fetched.mediaType };
    }
    const document = parseManifest(top.bytes, top.mediaType, ref);
    if (document.kind === 'manifest') {
      return {
        topDigest: top.digest,
        topBytes: top.bytes,
        manifestDigest: top.digest,
        manifestBytes: top.bytes,
        config: document.config,
        layers: document.layers,
        requested,
        fromJobStore,
      };
    }
    const { descriptor, platform } = choosePlatform(document.manifests, requested, rosetta, ref);
    const stored = await this.fromStores(stores, descriptor.digest, MAX_MANIFEST_BYTES);
    fromJobStore ||= stored?.from === jobStore;
    let manifestBytes = stored?.bytes;
    let mediaType: string | undefined = descriptor.mediaType;
    if (!manifestBytes) {
      const fetched = await session.manifest(descriptor.digest);
      if (fetched.digest !== descriptor.digest) {
        throw new PullError(`the registry sent a manifest for ${ref} whose digest is ${fetched.digest}, not ${descriptor.digest}`);
      }
      manifestBytes = fetched.bytes;
      mediaType = fetched.mediaType || mediaType;
    }
    const manifest = parseManifest(manifestBytes, mediaType, ref);
    if (manifest.kind !== 'manifest') throw new PullError(`the index for ${ref} names another index for ${platform}`);
    return {
      topDigest: top.digest,
      topBytes: top.bytes,
      indexDigest: top.digest,
      manifestDigest: descriptor.digest,
      manifestBytes,
      config: manifest.config,
      layers: manifest.layers,
      platform,
      requested,
      fromJobStore,
    };
  }

  /** The digest a tag names now, from a manifest HEAD; undefined when the registry did not say. */
  private async headDigest(session: RegistrySession, tag: string, ref: string): Promise<string | undefined> {
    const head = await session.head(tag);
    if (head === null) throw new PullError(`manifest for ${ref} not found: manifest unknown`);
    return head.digest;
  }

  /** The config's platform must be what was chosen, or, for a single manifest, one the VM runs (§6.2). */
  private checkConfigPlatform(
    resolved: ResolvedImage,
    config: { architecture: string; os: string; variant?: string },
    rosetta: RosettaState,
    ref: string
  ): string {
    const actual = `${config.os}/${config.architecture}`;
    if (resolved.platform) {
      const chosen = resolved.platform.split('/')[1];
      if (config.os !== 'linux' || config.architecture !== chosen) {
        throw new PullError(`the image config of ${ref} says ${cleanText(actual, 100)}, not the ${resolved.platform} its index named`);
      }
      return resolved.platform;
    }
    if (config.os !== 'linux' || (config.architecture !== 'arm64' && config.architecture !== 'amd64')) {
      throw new PullError(`image \`${ref}\` is ${cleanText(actual, 100)}; localmost's Docker VM runs linux/arm64 and linux/amd64 images`);
    }
    if (resolved.requested && resolved.requested.architecture !== config.architecture) {
      throw new PullError(`image \`${ref}\` is ${actual}, not the linux/${resolved.requested.architecture} the pull asked for`);
    }
    if (config.architecture === 'amd64' && rosetta !== 'ok') throw rosettaRefusal(ref, rosetta, resolved.requested !== undefined);
    return platformString(config.architecture, config.variant);
  }

  /** A config blob, from a store or fetched into memory, bounded and verified. */
  private async smallBlob(
    session: RegistrySession,
    stores: ImageStore[],
    descriptor: ContentDescriptor,
    max: number,
    budget: Budget,
    ref: string,
    signal: AbortSignal
  ): Promise<{ bytes: Buffer; from?: ImageStore }> {
    const stored = await this.fromStores(stores, descriptor.digest, max);
    if (stored) return stored;
    if (descriptor.size > max) throw new PullError(`the config of ${ref} is larger than ${max} bytes`);
    let bytes: Buffer | null = null;
    for (let attempt = 0; bytes === null; attempt++) {
      const taken = { bytes: 0 };
      try {
        budget.reserve(descriptor.size);
        const res = await session.blob(descriptor.digest);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of res) {
          const piece = chunk as Buffer;
          size += piece.length;
          if (size > descriptor.size) {
            res.destroy();
            throw new PullError(`blob ${descriptor.digest} of ${ref} is larger than the ${descriptor.size} bytes its descriptor declares`);
          }
          budget.take(piece.length, taken);
          chunks.push(piece);
        }
        bytes = Buffer.concat(chunks);
      } catch (error) {
        const failure = transferError(error, signal, `the config of ${ref}`);
        if (attempt > 0 || !(failure instanceof PullError) || !failure.transient) throw failure;
        budget.refund(taken);
        this.log('info', `retrying the config of ${ref}: ${failure.message}`);
      }
    }
    const actual = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    if (actual !== descriptor.digest) {
      throw new PullError(`${session.registry} sent ${actual} for the config ${descriptor.digest} of ${ref}`);
    }
    return { bytes };
  }

  private expansionLimit(compressedSize: number, limits: PullLimits): number {
    return Math.min(EXPANSION_BASE + EXPANSION_RATIO * compressedSize, limits.pullMaxGiB * EXPANSION_PULL_FACTOR * GiB);
  }

  private archiveSource(store: ImageStore, layer: ContentDescriptor, diffId: string) {
    return {
      digest: layer.digest,
      mediaType: layer.mediaType,
      diffId,
      open: () => fs.createReadStream('', { fd: fs.openSync(store.pathOf(layer.digest), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) }),
    };
  }

  /** Uncompressed sizes the store recorded for a manifest's layers. */
  private async knownSizes(store: ImageStore, manifestDigest: string): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    for (const entry of await store.readRefs()) {
      if (entry.manifestDigest !== manifestDigest) continue;
      for (const layer of entry.layers) sizes.set(layer.digest, layer.uncompressedSize);
    }
    return sizes;
  }

  /** Step 3 for one layer: fetch into the store, verified; retried once on a dropped transfer. Returns its uncompressed size. */
  private async fetchLayer(
    session: RegistrySession,
    store: ImageStore,
    layer: ContentDescriptor,
    diffId: string,
    budget: Budget,
    limits: PullLimits,
    ref: string,
    id: string,
    progress: (p: DockerProgress) => void,
    signal: AbortSignal
  ): Promise<number> {
    for (let attempt = 0; ; attempt++) {
      const taken = { bytes: 0 };
      try {
        return await this.fetchLayerOnce(session, store, layer, diffId, budget, taken, limits, ref, id, progress, signal);
      } catch (error) {
        if (attempt === 0 && error instanceof PullError && error.transient && !signal.aborted) {
          // What the broken transfer took was not kept: it does not count.
          budget.refund(taken);
          this.log('info', `retrying layer ${layer.digest} of ${ref}: ${error.message}`);
          continue;
        }
        throw error;
      }
    }
  }

  private async fetchLayerOnce(
    session: RegistrySession,
    store: ImageStore,
    layer: ContentDescriptor,
    diffId: string,
    budget: Budget,
    taken: { bytes: number },
    limits: PullLimits,
    ref: string,
    id: string,
    progress: (p: DockerProgress) => void,
    signal: AbortSignal
  ): Promise<number> {
    budget.reserve(layer.size);
    const limit = this.expansionLimit(layer.size, limits);
    const checkEvery = this.options.freeSpaceCheckBytes ?? FREE_SPACE_CHECK_BYTES;
    const writer = await store.createWriter(layer.digest);
    const decompressor = decompressorFor(layer.mediaType);
    const uncompressedHash = crypto.createHash('sha256');
    let uncompressed = 0;
    let decompressError: Error | null = null;
    decompressor.on('data', (chunk: Buffer) => {
      uncompressed += chunk.length;
      if (uncompressed > limit) {
        decompressError = new PullError(`layer ${layer.digest} of ${ref} expands past ${limit} bytes (at most 64 MiB plus 100 times its compressed size, and 4 × dockerVm.pullMaxGiB)`);
        decompressor.destroy();
        return;
      }
      uncompressedHash.update(chunk);
    });
    decompressor.on('error', (error) => {
      decompressError ??= new PullError(`layer ${layer.digest} of ${ref} could not be decompressed: ${cleanText(error.message, 200)}`);
    });
    const decompressed = new Promise<void>((resolve) => {
      decompressor.on('end', resolve);
      decompressor.on('close', resolve);
    });
    try {
      const res = await session.blob(layer.digest);
      let received = 0;
      let sinceCheck = 0;
      let sinceProgress = 0;
      for await (const chunk of res) {
        const bytes = chunk as Buffer;
        received += bytes.length;
        if (received > layer.size) {
          res.destroy();
          throw new PullError(`blob ${layer.digest} of ${ref} is larger than the ${layer.size} bytes its descriptor declares`);
        }
        budget.take(bytes.length, taken);
        await writer.write(bytes);
        if (decompressError) throw decompressError;
        if (!decompressor.write(bytes)) await drained(decompressor);
        if (decompressError) throw decompressError;
        sinceCheck += bytes.length;
        if (sinceCheck >= checkEvery) {
          sinceCheck = 0;
          await this.checkFreeSpace(limits.minFreeGiB);
        }
        sinceProgress += bytes.length;
        if (sinceProgress >= PROGRESS_STEP || received === layer.size) {
          sinceProgress = 0;
          progress({
            status: 'Downloading',
            id,
            progress: progressBar(received, layer.size),
            progressDetail: { current: received, total: layer.size },
          });
        }
      }
      if (received !== layer.size) {
        throw new PullError(`blob ${layer.digest} of ${ref} is ${received} bytes, not the ${layer.size} its descriptor declares`, true);
      }
      progress({ status: 'Verifying Checksum', id });
      decompressor.end();
      await decompressed;
      if (decompressError) throw decompressError;
      await writer.commit();
      const actual = `sha256:${uncompressedHash.digest('hex')}`;
      if (actual !== diffId) {
        await store.remove(layer.digest);
        throw new PullError(`layer ${layer.digest} of ${ref} uncompresses to ${actual}, not its diff_id ${diffId}`);
      }
      progress({ status: 'Download complete', id });
      return uncompressed;
    } catch (error) {
      decompressor.destroy();
      await writer.abort();
      if (error instanceof DigestMismatchError) {
        throw new PullError(`${session.registry} sent ${error.actual} for layer ${error.expected} of ${ref}`);
      }
      throw transferError(error, signal, `layer ${layer.digest} of ${ref}`);
    }
  }

  /** Keep the manifest, the index and the config beside the layers, once the whole image verified. */
  private async keep(store: ImageStore, resolved: ResolvedImage, config: { bytes: Buffer }): Promise<void> {
    const blobs: Array<[string, Buffer]> = [
      [resolved.manifestDigest, resolved.manifestBytes],
      [resolved.config.digest, config.bytes],
      ...(resolved.indexDigest ? [[resolved.indexDigest, resolved.topBytes] as [string, Buffer]] : []),
    ];
    for (const [digest, bytes] of blobs) {
      if (!(await store.has(digest))) await store.putBytes(digest, bytes);
    }
  }

  /** A cache-disk hit still counts as a pull for the store's LRU. */
  private async touch(store: ImageStore, ref: string, platform: string, manifestDigest: string): Promise<void> {
    const entry = (await store.readRefs()).find((r) => r.ref === ref && r.platform === platform && r.manifestDigest === manifestDigest);
    if (entry) await store.recordRef({ ...entry, lastPulled: this.now() });
  }
}
