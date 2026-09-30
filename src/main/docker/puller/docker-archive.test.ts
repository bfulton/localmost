import { describe, it, expect } from '@jest/globals';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import * as zlib from 'zlib';
import { ArchiveInput, LayerVerifyError, dockerArchive, measureLayer, tarHeader } from './docker-archive';
import { MEDIA, compress, tarOf } from './test-registry';

const sha = (bytes: Buffer) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** The entries of a ustar archive, in order. */
function untar(bytes: Buffer): Array<{ name: string; type: string; mode: string; mtime: string; uid: string; data: Buffer }> {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString('utf-8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    expect(parseInt(field(148, 8).trim(), 8)).toBe(sum);
    expect(field(257, 6)).toBe('ustar');
    entries.push({
      name: field(0, 100),
      type: field(156, 1),
      mode: field(100, 8),
      mtime: field(136, 12),
      uid: field(108, 8),
      data: bytes.subarray(offset + 512, offset + 512 + size),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function layerOf(tar: Buffer, compression: 'gzip' | 'zstd' | 'none') {
  const blob = compress(tar, compression);
  const mediaType = compression === 'gzip' ? MEDIA.ociLayerGzip : compression === 'zstd' ? MEDIA.ociLayerZstd : MEDIA.ociLayer;
  return {
    digest: sha(blob),
    mediaType,
    size: blob.length,
    diffId: sha(tar),
    uncompressedSize: tar.length,
    open: () => Readable.from([blob.subarray(0, 7), blob.subarray(7)]),
  };
}

function input(layers: ReturnType<typeof layerOf>[]): ArchiveInput {
  const config = Buffer.from(JSON.stringify({ architecture: 'arm64', os: 'linux', rootfs: { type: 'layers', diff_ids: layers.map((l) => l.diffId) } }));
  return {
    name: `docker.io/library/alpine@sha256:${'1'.repeat(64)}`,
    config,
    configDigest: sha(config),
    layers,
  };
}

describe('dockerArchive', () => {
  const tarA = tarOf([{ name: 'etc/a', content: 'first layer\n' }]);
  const tarB = tarOf([{ name: 'etc/b', content: Buffer.alloc(3000, 'b') }]);
  const tarC = tarOf([{ name: 'etc/c', content: 'third\n' }]);

  it('lays out oci-layout, index.json, manifest.json, the config and the uncompressed layers', async () => {
    const layers = [layerOf(tarA, 'gzip'), layerOf(tarB, 'zstd'), layerOf(tarC, 'none')];
    const image = input(layers);
    const entries = untar(await collect(dockerArchive(image)));
    const names = entries.map((e) => e.name);
    const manifestEntry = entries.find((e) => e.name.startsWith('blobs/sha256/') && e.data.toString().includes('schemaVersion'))!;
    const manifestName = manifestEntry.name;
    expect(names).toEqual([
      'oci-layout',
      'index.json',
      'manifest.json',
      'blobs/',
      'blobs/sha256/',
      `blobs/sha256/${image.configDigest.slice(7)}`,
      manifestName,
      `blobs/sha256/${layers[0].diffId.slice(7)}`,
      `blobs/sha256/${layers[1].diffId.slice(7)}`,
      `blobs/sha256/${layers[2].diffId.slice(7)}`,
    ]);
    const byName = new Map(entries.map((e) => [e.name, e.data]));
    expect(JSON.parse(byName.get('oci-layout')!.toString())).toEqual({ imageLayoutVersion: '1.0.0' });
    expect(JSON.parse(byName.get('manifest.json')!.toString())).toEqual([
      {
        Config: `blobs/sha256/${image.configDigest.slice(7)}`,
        RepoTags: null,
        Layers: layers.map((l) => `blobs/sha256/${l.diffId.slice(7)}`),
      },
    ]);
    const manifest = JSON.parse(manifestEntry.data.toString());
    expect(manifest).toEqual({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: image.configDigest, size: image.config.length },
      layers: layers.map((l) => ({ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: l.diffId, size: l.uncompressedSize })),
    });
    expect(manifestName).toBe(`blobs/sha256/${sha(manifestEntry.data).slice(7)}`);
    expect(JSON.parse(byName.get('index.json')!.toString())).toEqual({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: sha(manifestEntry.data),
          size: manifestEntry.data.length,
          annotations: { 'io.containerd.image.name': image.name },
        },
      ],
    });
    expect(byName.get(`blobs/sha256/${image.configDigest.slice(7)}`)).toEqual(image.config);
    expect(byName.get(`blobs/sha256/${layers[0].diffId.slice(7)}`)).toEqual(tarA);
    expect(byName.get(`blobs/sha256/${layers[1].diffId.slice(7)}`)).toEqual(tarB);
    expect(byName.get(`blobs/sha256/${layers[2].diffId.slice(7)}`)).toEqual(tarC);
    for (const entry of entries) {
      expect(entry.mtime).toBe('00000000000');
      expect(entry.uid).toBe('0000000');
    }
  });

  it('writes a layer that appears twice once', async () => {
    const layers = [layerOf(tarA, 'gzip'), layerOf(tarA, 'gzip')];
    const names = untar(await collect(dockerArchive(input(layers)))).map((e) => e.name);
    expect(names.filter((n) => n === `blobs/sha256/${layers[0].diffId.slice(7)}`)).toHaveLength(1);
  });

  it('is the same byte stream every time', async () => {
    const make = () => dockerArchive(input([layerOf(tarA, 'gzip'), layerOf(tarB, 'zstd')]));
    const first = await collect(make());
    const second = await collect(make());
    expect(first.equals(second)).toBe(true);
    expect(first.length % 512).toBe(0);
  });

  it.each(['gzip', 'zstd'] as const)('fails a %s layer whose uncompressed bytes do not match its diff_id', async (compression) => {
    const layer = { ...layerOf(tarA, compression), diffId: sha(tarB) };
    const error = await collect(dockerArchive(input([layer]))).catch((e) => e);
    expect(error).toBeInstanceOf(LayerVerifyError);
    expect(error.message).toContain(`layer ${layer.digest}`);
    expect(error.message).toContain(`diff_id ${sha(tarB)}`);
    expect((error as LayerVerifyError).digest).toBe(layer.digest);
  });

  it('fails a layer whose stored bytes no longer match their digest', async () => {
    const good = layerOf(tarA, 'gzip');
    const altered = compress(tarA, 'gzip');
    altered[4] ^= 0xff; // the gzip mtime: still a valid stream of the same tar
    const layer = { ...good, open: () => Readable.from([altered]) };
    await expect(collect(dockerArchive(input([layer])))).rejects.toThrow(`layer ${good.digest} no longer matches its digest`);
  });

  it('fails a layer that is longer than its recorded size', async () => {
    const layer = { ...layerOf(tarB, 'zstd'), uncompressedSize: tarB.length - 512 };
    await expect(collect(dockerArchive(input([layer])))).rejects.toThrow(LayerVerifyError);
  });

  it('fails a layer that is not the compression its media type names', async () => {
    const tar = tarA;
    const layer = { ...layerOf(tar, 'none'), mediaType: MEDIA.ociLayerGzip };
    await expect(collect(dockerArchive(input([layer])))).rejects.toThrow();
  });
});

describe('measureLayer', () => {
  it.each(['gzip', 'zstd', 'none'] as const)('gives the uncompressed size of a %s layer after checking both digests', async (compression) => {
    const tar = tarOf([{ name: 'x', content: Buffer.alloc(5000, 'x') }]);
    const layer = layerOf(tar, compression);
    await expect(measureLayer(layer)).resolves.toBe(tar.length);
    await expect(measureLayer({ ...layer, diffId: sha(Buffer.from('other')) })).rejects.toThrow(LayerVerifyError);
  });

  it('reads a gzip stream of several members, as some registries serve them', async () => {
    const tar = tarOf([{ name: 'x', content: 'multi' }]);
    const blob = Buffer.concat([zlib.gzipSync(tar.subarray(0, 512)), zlib.gzipSync(tar.subarray(512))]);
    const layer = { digest: sha(blob), mediaType: MEDIA.ociLayerGzip, size: blob.length, diffId: sha(tar), open: () => Readable.from([blob]) };
    await expect(measureLayer(layer)).resolves.toBe(tar.length);
  });
});

describe('tarHeader', () => {
  it('writes sizes past the octal field in base 256', () => {
    const header = tarHeader('big', 'file', 10 * 1024 ** 3);
    expect(header[124]).toBe(0x80);
    expect(header.readBigUInt64BE(128)).toBe(BigInt(10 * 1024 ** 3));
  });

  it('refuses a name that does not fit', () => {
    expect(() => tarHeader('x'.repeat(101), 'file', 0)).toThrow();
  });
});
