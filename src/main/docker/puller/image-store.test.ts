import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DigestMismatchError, ImageStore, StoreRef } from './image-store';

const digestOf = (bytes: Buffer) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

let scratch: string;
let root: string;
let store: ImageStore;

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'image-store-')));
  root = path.join(scratch, 'vm', 'images', '0123456789abcdef');
  store = new ImageStore(root);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

const blobsDir = () => path.join(root, 'blobs', 'sha256');
const listBlobs = () => (fs.existsSync(blobsDir()) ? fs.readdirSync(blobsDir()).sort() : []);

async function put(bytes: Buffer): Promise<string> {
  const digest = digestOf(bytes);
  await store.putBytes(digest, bytes);
  return digest;
}

function entry(over: Partial<StoreRef> & { layerBytes?: Buffer[] } = {}): StoreRef {
  return {
    ref: 'docker.io/library/alpine:3',
    platform: 'linux/arm64',
    manifestDigest: digestOf(Buffer.from('manifest')),
    configDigest: digestOf(Buffer.from('config')),
    layers: [],
    lastPulled: 1,
    ...over,
  };
}

describe('writing blobs', () => {
  it('puts a blob in place only when its bytes match its digest', async () => {
    const bytes = Buffer.from('layer bytes');
    const writer = await store.createWriter(digestOf(bytes));
    await writer.write(bytes);
    await writer.commit();
    expect(listBlobs()).toEqual([digestOf(bytes).slice(7)]);
    expect(fs.readFileSync(path.join(blobsDir(), digestOf(bytes).slice(7)))).toEqual(bytes);
  });

  it('leaves nothing in place when the digest does not match', async () => {
    const expected = digestOf(Buffer.from('what the descriptor said'));
    const writer = await store.createWriter(expected);
    await writer.write(Buffer.from('what the registry sent'));
    const error = await writer.commit().catch((e) => e);
    expect(error).toBeInstanceOf(DigestMismatchError);
    expect((error as DigestMismatchError).expected).toBe(expected);
    expect((error as DigestMismatchError).actual).toBe(digestOf(Buffer.from('what the registry sent')));
    expect(listBlobs()).toEqual([]);
  });

  it('leaves nothing behind when a write is abandoned', async () => {
    const writer = await store.createWriter(digestOf(Buffer.from('x')));
    await writer.write(Buffer.from('partial'));
    await writer.abort();
    expect(listBlobs()).toEqual([]);
  });

  it('leaves only a .tmp- file when interrupted, and a sweep at startup removes it', async () => {
    const writer = await store.createWriter(digestOf(Buffer.from('never finished')));
    await writer.write(Buffer.from('never'));
    // The process dies here: no commit, no abort.
    const left = listBlobs();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^\.tmp-[0-9a-f]+$/);
    await writer.close();
    const kept = await put(Buffer.from('a real blob'));
    await new ImageStore(root).sweepTemp();
    expect(listBlobs()).toEqual([kept.slice(7)]);
  });

  it('sweeps an interrupted refs.json write too, and nothing else', async () => {
    await store.recordRef(entry());
    const left = path.join(root, `refs.json.tmp-${'0'.repeat(16)}`);
    const other = path.join(root, 'refs.json.tmp-not-ours');
    fs.writeFileSync(left, '{ half');
    fs.writeFileSync(other, 'x');
    await new ImageStore(root).sweepTemp();
    expect(fs.existsSync(left)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(await store.readRefs()).toHaveLength(1);
  });

  it('refuses a malformed digest before any file is made', async () => {
    for (const bad of ['sha256:../../helper.sb', `sha256:${'A'.repeat(64)}`, `sha512:${'a'.repeat(128)}`, 'sha256:abc']) {
      await expect(store.createWriter(bad)).rejects.toThrow();
      await expect(store.putBytes(bad, Buffer.from('x'))).rejects.toThrow();
      await expect(store.readVerified(bad, 1024)).rejects.toThrow();
      await expect(store.has(bad)).rejects.toThrow();
      await expect(store.remove(bad)).rejects.toThrow();
    }
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe('reading blobs', () => {
  it('re-verifies a blob on every read, and deletes one that no longer matches', async () => {
    const bytes = Buffer.from('config json');
    const digest = await put(bytes);
    await expect(store.readVerified(digest, 1024)).resolves.toEqual(bytes);
    fs.writeFileSync(path.join(blobsDir(), digest.slice(7)), 'tampered');
    await expect(store.readVerified(digest, 1024)).resolves.toBeNull();
    expect(listBlobs()).toEqual([]);
  });

  it('never reads a blob through a symlink, even to bytes that match', async () => {
    const bytes = Buffer.from('bytes kept somewhere else');
    const target = path.join(scratch, 'elsewhere');
    fs.writeFileSync(target, bytes);
    fs.mkdirSync(blobsDir(), { recursive: true });
    fs.symlinkSync(target, path.join(blobsDir(), digestOf(bytes).slice(7)));
    await expect(store.readVerified(digestOf(bytes), 1024)).resolves.toBeNull();
    expect(fs.readFileSync(target)).toEqual(bytes);
  });

  it('answers null for a blob it does not have, and refuses one past the bound', async () => {
    await expect(store.readVerified(digestOf(Buffer.from('absent')), 1024)).resolves.toBeNull();
    const digest = await put(Buffer.alloc(2048, 7));
    await expect(store.readVerified(digest, 1024)).rejects.toThrow('larger than');
  });
});

describe('refs.json', () => {
  it('records a reference per name and platform, replacing an older one', async () => {
    await store.recordRef(entry({ lastPulled: 1 }));
    await store.recordRef(entry({ platform: 'linux/amd64', lastPulled: 2 }));
    await store.recordRef(entry({ lastPulled: 3 }));
    const refs = await store.readRefs();
    expect(refs.map((r) => [r.platform, r.lastPulled])).toEqual([
      ['linux/amd64', 2],
      ['linux/arm64', 3],
    ]);
  });

  it('updates atomically: concurrent records all land and no temporary file is left', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.recordRef(entry({ ref: `docker.io/library/img${i}:latest`, lastPulled: i })))
    );
    expect(await store.readRefs()).toHaveLength(25);
    expect(fs.readdirSync(root).filter((f) => f.startsWith('refs.json'))).toEqual(['refs.json']);
    expect(() => JSON.parse(fs.readFileSync(path.join(root, 'refs.json'), 'utf-8'))).not.toThrow();
  });

  it('refuses a hand-edited entry holding a traversal-shaped digest, and never builds a path from it', async () => {
    const good = entry();
    const canary = path.join(scratch, 'canary');
    fs.writeFileSync(canary, 'keep me');
    fs.mkdirSync(root, { recursive: true });
    const traversal = `sha256:../../../../canary`;
    fs.writeFileSync(
      path.join(root, 'refs.json'),
      JSON.stringify({
        v: 1,
        refs: [
          good,
          { ...good, ref: 'docker.io/library/evil:1', configDigest: traversal },
          { ...good, ref: 'docker.io/library/evil:2', manifestDigest: `sha512:${'a'.repeat(128)}` },
          {
            ...good,
            ref: 'docker.io/library/evil:3',
            layers: [{ digest: traversal, mediaType: 'application/vnd.oci.image.layer.v1.tar', size: 1, diffId: good.configDigest, uncompressedSize: 1 }],
          },
          { ...good, ref: 'docker.io/library/evil:4', platform: 'linux/amd64; rm -rf' },
        ],
      })
    );
    const refs = await store.readRefs();
    expect(refs).toEqual([good]);
    await store.trim(0);
    expect(fs.readFileSync(canary, 'utf-8')).toBe('keep me');
  });

  it('leaves refs.json whole when a write dies partway', async () => {
    await store.recordRef(entry({ ref: 'docker.io/library/kept:1' }));
    const realWriteFile = fs.promises.writeFile.bind(fs.promises);
    const writeFile = jest.spyOn(fs.promises, 'writeFile').mockImplementationOnce(async (file, data, options) => {
      // Half the new contents reach the disk, then the process dies.
      const text = String(data);
      await realWriteFile(file as string, text.slice(0, text.length / 2), options as fs.WriteFileOptions);
      throw new Error('killed mid-write');
    });
    try {
      await expect(store.recordRef(entry({ ref: 'docker.io/library/new:1' }))).rejects.toThrow('killed mid-write');
    } finally {
      writeFile.mockRestore();
    }
    expect((await store.readRefs()).map((r) => r.ref)).toEqual(['docker.io/library/kept:1']);
    expect(fs.readdirSync(root).filter((f) => f.startsWith('refs.json'))).toEqual(['refs.json']);
  });

  it('never reads refs.json through a symlink', async () => {
    const elsewhere = path.join(scratch, 'refs-elsewhere.json');
    fs.writeFileSync(elsewhere, JSON.stringify({ v: 1, refs: [entry()] }));
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(root, 'refs.json'));
    await expect(store.readRefs()).resolves.toEqual([]);
  });

  it('reads a refs.json that is not JSON as empty, and a missing one too', async () => {
    await expect(store.readRefs()).resolves.toEqual([]);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'refs.json'), '{ nope');
    await expect(store.readRefs()).resolves.toEqual([]);
  });
});

describe('trimming', () => {
  /** A stored image: its config, manifest and one layer of `size` bytes. */
  async function image(name: string, size: number, lastPulled: number): Promise<StoreRef> {
    const layer = crypto.randomBytes(size);
    const layerDigest = await put(layer);
    const config = await put(Buffer.from(`config ${name}`));
    const manifest = await put(Buffer.from(`manifest ${name}`));
    const ref = entry({
      ref: `docker.io/library/${name}:1`,
      manifestDigest: manifest,
      configDigest: config,
      layers: [{ digest: layerDigest, mediaType: 'application/vnd.oci.image.layer.v1.tar', size, diffId: layerDigest, uncompressedSize: size }],
      lastPulled,
    });
    await store.recordRef(ref);
    return ref;
  }

  it('drops the least recently pulled references until the store and the disk estimate fit the limit', async () => {
    await image('oldest', 40_000, 1);
    await image('middle', 40_000, 2);
    const newest = await image('newest', 40_000, 3);
    // Each image costs its blobs on the Mac plus its uncompressed layer on the golden disk.
    const { kept, dropped } = await store.trim(170_000);
    expect(dropped.map((r) => r.ref)).toEqual(['docker.io/library/oldest:1']);
    expect(kept.map((r) => r.ref).sort()).toEqual(['docker.io/library/middle:1', 'docker.io/library/newest:1']);
    expect(await store.usage()).toBeLessThanOrEqual(170_000);
    expect(await store.has(newest.layers[0].digest)).toBe(true);
    const remaining = await store.readRefs();
    expect(remaining).toHaveLength(2);
  });

  it('removes blobs no reference holds, and keeps blobs a pull has pinned', async () => {
    const orphan = await put(Buffer.from('from a failed pull'));
    const pinnedOrphan = await put(Buffer.from('being pulled right now'));
    const release = store.pin([pinnedOrphan]);
    await image('kept', 1000, 1);
    await store.trim(1_000_000);
    expect(await store.has(orphan)).toBe(false);
    expect(await store.has(pinnedOrphan)).toBe(true);
    release();
    await store.trim(1_000_000);
    expect(await store.has(pinnedOrphan)).toBe(false);
  });

  it('never deletes anything but blob files under blobs/sha256', async () => {
    await image('a', 1000, 1);
    fs.writeFileSync(path.join(blobsDir(), 'not-a-digest'), 'x');
    fs.writeFileSync(path.join(root, 'other-file'), 'x');
    await store.trim(0);
    expect(fs.existsSync(path.join(blobsDir(), 'not-a-digest'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'other-file'))).toBe(true);
    expect(await store.readRefs()).toEqual([]);
  });
});
