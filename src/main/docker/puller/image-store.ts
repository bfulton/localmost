/**
 * A blob store verified by digest, and its refs.json (contract §6.3).
 *
 * One store per repository, `<data>/vm/images/<repoKey>`, holds the public
 * images the repository pulled; a per-job store, rooted at the VM's own
 * directory, holds images that needed credentials and goes with the VM.
 *
 * Every path is built by blobPath() from a digest that was checked first,
 * because the digests come from a registry, from the VM or from a refs.json
 * anyone with the user's rights could edit, and Electron main both reads and
 * deletes by these paths. A blob is written to `.tmp-<random>` while it is
 * hashed and renamed into place only if it matches; a read hashes it again;
 * a blob that fails is deleted and fetched again.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { blobPath, digestHex, DIGEST_RE } from '../../vm/paths';
import { cleanText } from './clean-text';

const REFS_FILE = 'refs.json';
const TMP_PREFIX = '.tmp-';
const HEX64 = /^[0-9a-f]{64}$/;
/** What createWriter names a blob in progress. */
const TMP_NAME = /^\.tmp-[0-9a-f]{16}$/;
/** What writeRefs names refs.json in progress. */
const REFS_TMP_NAME = /^refs\.json\.tmp-[0-9a-f]{16}$/;
const MAX_REFS_BYTES = 16 * 1024 * 1024;
const MAX_LAYERS = 256;
/** `<registry>/<path>:<tag>` or `<registry>/<path>@sha256:<hex>`, as the puller writes them. */
const REF_RE = /^[a-z0-9.-]+(?::[0-9]{1,5})?\/[a-z0-9._/-]{1,255}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$/;
/** The platforms the VM runs. */
export const PLATFORM_RE = /^linux\/(?:arm64(?:\/v[0-9])?|amd64)$/;

export interface StoreLayer {
  /** The compressed blob's digest, as the manifest names it. */
  digest: string;
  mediaType: string;
  size: number;
  /** The uncompressed tar's digest: the config's diff_id. */
  diffId: string;
  uncompressedSize: number;
}

/** One pulled reference: what it resolved to, for one platform, and when. */
export interface StoreRef {
  ref: string;
  platform: string;
  manifestDigest: string;
  configDigest: string;
  /** The index the platform's manifest was chosen from, when there was one. */
  indexDigest?: string;
  layers: StoreLayer[];
  /** Milliseconds since the epoch. */
  lastPulled: number;
}

export class DigestMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super(`expected ${expected}, got ${actual}`);
    this.name = 'DigestMismatchError';
  }
}

/** The path of a digest's blob, or a throw: the one place a store path comes from. */
function pathOf(root: string, digest: string): string {
  const hex = digestHex(digest);
  if (hex === null) throw new Error(`not a sha256 digest: ${JSON.stringify(cleanText(String(digest), 100))}`);
  return blobPath(root, hex);
}

/** Blobs a pull in progress holds, by path, so that a trim running meanwhile keeps them. */
const pinned = new Map<string, number>();
/** One refs.json update at a time per store, across every ImageStore on it. */
const refsLocks = new Map<string, Promise<unknown>>();

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** An entry read back from refs.json, or null when any field is not what the puller writes. */
function validRef(value: unknown): StoreRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.ref !== 'string' || !REF_RE.test(v.ref)) return null;
  if (typeof v.platform !== 'string' || !PLATFORM_RE.test(v.platform)) return null;
  if (!isDigest(v.manifestDigest) || !isDigest(v.configDigest)) return null;
  if (v.indexDigest !== undefined && !isDigest(v.indexDigest)) return null;
  if (typeof v.lastPulled !== 'number' || !Number.isFinite(v.lastPulled)) return null;
  if (!Array.isArray(v.layers) || v.layers.length > MAX_LAYERS) return null;
  const layers: StoreLayer[] = [];
  for (const layer of v.layers) {
    if (typeof layer !== 'object' || layer === null) return null;
    const l = layer as Record<string, unknown>;
    if (!isDigest(l.digest) || !isDigest(l.diffId) || typeof l.mediaType !== 'string' || l.mediaType.length > 255) return null;
    if (!isCount(l.size) || !isCount(l.uncompressedSize)) return null;
    layers.push({ digest: l.digest, mediaType: l.mediaType, size: l.size, diffId: l.diffId, uncompressedSize: l.uncompressedSize });
  }
  return {
    ref: v.ref,
    platform: v.platform,
    manifestDigest: v.manifestDigest,
    configDigest: v.configDigest,
    ...(v.indexDigest !== undefined ? { indexDigest: v.indexDigest as string } : {}),
    layers,
    lastPulled: v.lastPulled,
  };
}

/** Every blob a reference needs in the store. */
export function blobsOf(ref: StoreRef): string[] {
  return [ref.manifestDigest, ref.configDigest, ...(ref.indexDigest ? [ref.indexDigest] : []), ...ref.layers.map((l) => l.digest)];
}

/**
 * What a set of references is estimated to take on the golden disk: each
 * distinct uncompressed layer once.
 */
export function diskEstimate(refs: StoreRef[]): number {
  const layers = new Map<string, number>();
  for (const ref of refs) for (const layer of ref.layers) layers.set(layer.diffId, layer.uncompressedSize);
  let total = 0;
  for (const size of layers.values()) total += size;
  return total;
}

/** Streams one blob into the store while hashing it; see ImageStore.createWriter. */
export class BlobWriter {
  private readonly hash = crypto.createHash('sha256');
  private written = 0;
  private closed = false;

  constructor(
    private readonly handle: fs.promises.FileHandle,
    private readonly tmpPath: string,
    private readonly finalPath: string,
    readonly expected: string
  ) {}

  get bytesWritten(): number {
    return this.written;
  }

  async write(chunk: Buffer): Promise<void> {
    this.hash.update(chunk);
    this.written += chunk.length;
    let offset = 0;
    while (offset < chunk.length) {
      const { bytesWritten } = await this.handle.write(chunk, offset, chunk.length - offset);
      offset += bytesWritten;
    }
  }

  /** Close the file and leave it where it is: what a crash would do. Tests use it; see abort. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }

  /** Put the blob in place if it hashes to what was expected; otherwise delete it and throw DigestMismatchError. */
  async commit(): Promise<void> {
    await this.close();
    const actual = `sha256:${this.hash.digest('hex')}`;
    if (actual !== this.expected) {
      await fs.promises.rm(this.tmpPath, { force: true });
      throw new DigestMismatchError(this.expected, actual);
    }
    await fs.promises.rename(this.tmpPath, this.finalPath);
  }

  async abort(): Promise<void> {
    await this.close().catch(() => undefined);
    await fs.promises.rm(this.tmpPath, { force: true });
  }
}

export class ImageStore {
  constructor(
    readonly root: string,
    private readonly log: (message: string) => void = () => undefined
  ) {
    if (!path.isAbsolute(root)) throw new Error(`an image store root must be absolute: ${root}`);
  }

  private get blobsDir(): string {
    return path.join(this.root, 'blobs', 'sha256');
  }

  private get refsPath(): string {
    return path.join(this.root, REFS_FILE);
  }

  /** Where a blob lives; throws on a digest that is not `sha256:<64 hex>`. */
  pathOf(digest: string): string {
    return pathOf(this.root, digest);
  }

  async has(digest: string): Promise<boolean> {
    const file = this.pathOf(digest);
    try {
      return (await fs.promises.lstat(file)).isFile();
    } catch {
      return false;
    }
  }

  async size(digest: string): Promise<number | null> {
    const file = this.pathOf(digest);
    try {
      const stat = await fs.promises.lstat(file);
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  }

  async remove(digest: string): Promise<void> {
    await fs.promises.rm(this.pathOf(digest), { force: true });
  }

  /** A new blob, written to `.tmp-<random>` beside where it will go. */
  async createWriter(digest: string): Promise<BlobWriter> {
    const finalPath = this.pathOf(digest);
    await fs.promises.mkdir(this.blobsDir, { recursive: true, mode: 0o700 });
    const tmpPath = path.join(this.blobsDir, `${TMP_PREFIX}${crypto.randomBytes(8).toString('hex')}`);
    const handle = await fs.promises.open(tmpPath, 'wx', 0o600);
    return new BlobWriter(handle, tmpPath, finalPath, digest);
  }

  /** A small blob (a manifest, a config) already in memory. */
  async putBytes(digest: string, bytes: Buffer): Promise<void> {
    const writer = await this.createWriter(digest);
    try {
      await writer.write(bytes);
    } catch (error) {
      await writer.abort();
      throw error;
    }
    await writer.commit();
  }

  /**
   * A small blob's bytes, hashed again: null when the store does not have it,
   * or when what it has no longer matches, in which case it is deleted.
   */
  async readVerified(digest: string, max: number): Promise<Buffer | null> {
    const file = this.pathOf(digest);
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch {
      return null;
    }
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return null;
      if (stat.size > max) throw new Error(`blob ${digest} is larger than ${max} bytes`);
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` !== digest) {
      this.log(`blob ${digest} no longer matches its digest; deleted`);
      await fs.promises.rm(file, { force: true });
      return null;
    }
    return bytes;
  }

  /**
   * Remove what interrupted writes left behind: blobs in progress, and
   * refs.json in progress. Run before the store is first written in a process.
   */
  async sweepTemp(): Promise<void> {
    const sweep = async (dir: string, pattern: RegExp) => {
      let names: string[];
      try {
        names = await fs.promises.readdir(dir);
      } catch {
        return;
      }
      await Promise.all(names.filter((n) => pattern.test(n)).map((n) => fs.promises.rm(path.join(dir, n), { force: true })));
    };
    await sweep(this.blobsDir, TMP_NAME);
    await sweep(this.root, REFS_TMP_NAME);
  }

  /** Hold blobs against a trim while a pull or a load uses them. The returned function releases them. */
  pin(digests: string[]): () => void {
    const files = digests.map((d) => this.pathOf(d));
    for (const file of files) pinned.set(file, (pinned.get(file) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const file of files) {
        const count = (pinned.get(file) ?? 1) - 1;
        if (count <= 0) pinned.delete(file);
        else pinned.set(file, count);
      }
    };
  }

  /** The references in refs.json; an entry with any malformed field is refused and left out. */
  async readRefs(): Promise<StoreRef[]> {
    let text: string;
    try {
      const handle = await fs.promises.open(this.refsPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if ((await handle.stat()).size > MAX_REFS_BYTES) {
          this.log(`${this.refsPath} is too large; ignored`);
          return [];
        }
        text = await handle.readFile('utf-8');
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      this.log(`${this.refsPath} is not JSON; ignored`);
      return [];
    }
    const entries = typeof body === 'object' && body !== null && Array.isArray((body as { refs?: unknown }).refs)
      ? (body as { refs: unknown[] }).refs
      : [];
    const refs: StoreRef[] = [];
    let refused = 0;
    for (const value of entries) {
      const ref = validRef(value);
      if (ref) refs.push(ref);
      else refused++;
    }
    if (refused > 0) this.log(`${this.refsPath}: refused ${refused} malformed entr${refused === 1 ? 'y' : 'ies'}`);
    return refs;
  }

  private async withRefsLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = refsLocks.get(this.root) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.catch(() => undefined);
    refsLocks.set(this.root, settled);
    try {
      return await run;
    } finally {
      if (refsLocks.get(this.root) === settled) refsLocks.delete(this.root);
    }
  }

  /** Write refs.json whole, through a temporary file and a rename, so a reader never sees half of it. */
  private async writeRefs(refs: StoreRef[]): Promise<void> {
    await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.root, `${REFS_FILE}${TMP_PREFIX}${crypto.randomBytes(8).toString('hex')}`);
    try {
      await fs.promises.writeFile(tmp, JSON.stringify({ v: 1, refs }, null, 1), { flag: 'wx', mode: 0o600 });
      await fs.promises.rename(tmp, this.refsPath);
    } catch (error) {
      await fs.promises.rm(tmp, { force: true });
      throw error;
    }
  }

  /** Record a pull: one entry per reference and platform, the newest replacing an older one. */
  async recordRef(entry: StoreRef): Promise<void> {
    if (!validRef(entry)) throw new Error(`refusing to record a malformed reference ${cleanText(entry.ref, 200)}`);
    await this.withRefsLock(async () => {
      const refs = (await this.readRefs()).filter((r) => !(r.ref === entry.ref && r.platform === entry.platform));
      refs.push(entry);
      refs.sort((a, b) => a.lastPulled - b.lastPulled || a.ref.localeCompare(b.ref));
      await this.writeRefs(refs);
    });
  }

  /** Bytes of every blob in the store. */
  async usage(): Promise<number> {
    let total = 0;
    for (const name of await this.blobNames()) {
      try {
        total += (await fs.promises.lstat(path.join(this.blobsDir, name))).size;
      } catch {
        // Removed meanwhile.
      }
    }
    return total;
  }

  private async blobNames(): Promise<string[]> {
    try {
      return (await fs.promises.readdir(this.blobsDir)).filter((n) => HEX64.test(n));
    } catch {
      return [];
    }
  }

  /**
   * Keep the store and the golden disk within `limitBytes` (cacheLimitGiB):
   * drop the least recently pulled references until what the rest need on
   * the Mac plus their diskEstimate fits, then delete every blob no remaining
   * reference holds and no pull has pinned. Only files named by a digest
   * under blobs/sha256 are ever deleted.
   */
  async trim(limitBytes: number): Promise<{ kept: StoreRef[]; dropped: StoreRef[] }> {
    return this.withRefsLock(async () => {
      const refs = (await this.readRefs()).sort((a, b) => a.lastPulled - b.lastPulled);
      const sizes = new Map<string, number>();
      for (const ref of refs) {
        for (const digest of blobsOf(ref)) {
          if (!sizes.has(digest)) sizes.set(digest, (await this.size(digest)) ?? 0);
        }
      }
      const cost = (kept: StoreRef[]): number => {
        const blobs = new Set<string>();
        for (const ref of kept) for (const digest of blobsOf(ref)) blobs.add(digest);
        let total = diskEstimate(kept);
        for (const digest of blobs) total += sizes.get(digest) ?? 0;
        return total;
      };
      const kept = [...refs];
      const dropped: StoreRef[] = [];
      while (kept.length > 0 && cost(kept) > limitBytes) dropped.push(kept.shift()!);
      if (dropped.length > 0) await this.writeRefs(kept);

      const held = new Set<string>();
      for (const ref of kept) for (const digest of blobsOf(ref)) held.add(digest.slice('sha256:'.length));
      for (const name of await this.blobNames()) {
        const file = blobPath(this.root, name);
        if (held.has(name) || pinned.has(file)) continue;
        await fs.promises.rm(file, { force: true });
      }
      return { kept, dropped };
    });
  }
}
