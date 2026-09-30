/**
 * The archive the puller sends to `POST /images/load` (contract §6.4 step 4):
 * a `docker save`-shaped tar holding `oci-layout`, an `index.json` whose one
 * manifest carries the image's name, a `manifest.json` with `RepoTags: null`,
 * the config, an OCI manifest over the layers as the archive holds them, and
 * the layers uncompressed. The image id dockerd gives it is the config digest.
 *
 * Every layer is read from the store and checked again as it streams: the
 * stored bytes against the manifest's digest, the uncompressed bytes against
 * the config's diff_id, and the length against the size recorded when it was
 * first verified, which the tar header must state before the bytes. A layer
 * that fails ends the stream with a LayerVerifyError, so the daemon sees a
 * truncated archive and loads nothing.
 *
 * The byte stream is deterministic: fixed order, mtime 0, owner 0, fixed modes.
 */

import * as crypto from 'crypto';
import { PassThrough, Readable, Transform } from 'stream';
import * as zlib from 'zlib';
import { LAYER_TYPES } from './registry-client';

const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json';
const OCI_LAYER = 'application/vnd.oci.image.layer.v1.tar';
const BLOCK = 512;
/** The largest size the 11-digit octal field holds; past it, base 256. */
const OCTAL_MAX = 8 ** 11 - 1;

/** A layer that failed its check while it was read back from the store. */
export class LayerVerifyError extends Error {
  constructor(
    readonly digest: string,
    message: string
  ) {
    super(message);
    this.name = 'LayerVerifyError';
  }
}

export interface ArchiveLayerSource {
  /** The compressed blob's digest, as the manifest names it. */
  digest: string;
  mediaType: string;
  /** The config's diff_id for this layer. */
  diffId: string;
  /** The stored (compressed) bytes. */
  open(): Readable;
}

export interface ArchiveLayer extends ArchiveLayerSource {
  uncompressedSize: number;
}

export interface ArchiveInput {
  /** `<registry>/<path>@<manifest digest>`: the index's io.containerd.image.name. */
  name: string;
  config: Buffer;
  configDigest: string;
  layers: ArchiveLayer[];
}

const sha256 = (bytes: Buffer): string => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

/** A ustar header: name, type, size; everything else fixed. */
export function tarHeader(name: string, type: 'file' | 'dir', size: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar entry name too long: ${name}`);
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, 'utf-8');
  header.write(type === 'dir' ? '0000755\0' : '0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  if (size <= OCTAL_MAX) {
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  } else {
    // GNU base-256: the high bit of the first byte set, the size big-endian after it.
    header[124] = 0x80;
    header.writeBigUInt64BE(BigInt(size), 128);
  }
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type === 'dir' ? '5' : '0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

const padding = (size: number): Buffer => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

function fileEntry(name: string, data: Buffer): Buffer[] {
  return [tarHeader(name, 'file', data.length), data, padding(data.length)];
}

function decompressorFor(layer: ArchiveLayerSource): Transform {
  const compression = LAYER_TYPES.get(layer.mediaType);
  if (compression === 'gzip') return zlib.createGunzip();
  if (compression === 'zstd') return zlib.createZstdDecompress();
  if (compression === 'none') return new PassThrough();
  throw new LayerVerifyError(layer.digest, `layer ${layer.digest} has media type ${layer.mediaType}, which localmost does not load`);
}

/**
 * Stream a layer's uncompressed bytes, checking the stored bytes against its
 * digest and the uncompressed bytes against its diff_id (and, when given,
 * the size) as they pass. `limit` bounds the uncompressed bytes.
 */
async function* verifiedLayer(layer: ArchiveLayerSource, expectedSize: number | undefined, limit: number): AsyncGenerator<Buffer> {
  const compressedHash = crypto.createHash('sha256');
  const uncompressedHash = crypto.createHash('sha256');
  const source = layer.open();
  const decompressor = decompressorFor(layer);
  source.pipe(decompressor);
  source.on('data', (chunk: Buffer) => compressedHash.update(chunk));
  source.on('error', (error) => decompressor.destroy(error));
  let size = 0;
  const bound = expectedSize ?? limit;
  try {
    for await (const chunk of decompressor) {
      const bytes = chunk as Buffer;
      size += bytes.length;
      if (size > bound) {
        throw new LayerVerifyError(
          layer.digest,
          expectedSize !== undefined
            ? `layer ${layer.digest} is longer than the ${expectedSize} bytes it had when it was verified`
            : `layer ${layer.digest} expands past ${limit} bytes`
        );
      }
      uncompressedHash.update(bytes);
      yield bytes;
    }
  } catch (error) {
    if (error instanceof LayerVerifyError) throw error;
    throw new LayerVerifyError(layer.digest, `layer ${layer.digest} could not be decompressed: ${(error as Error).message}`);
  } finally {
    source.destroy();
    decompressor.destroy();
  }
  const compressed = `sha256:${compressedHash.digest('hex')}`;
  if (compressed !== layer.digest) {
    throw new LayerVerifyError(layer.digest, `layer ${layer.digest} no longer matches its digest (got ${compressed})`);
  }
  const uncompressed = `sha256:${uncompressedHash.digest('hex')}`;
  if (uncompressed !== layer.diffId) {
    throw new LayerVerifyError(layer.digest, `layer ${layer.digest} uncompresses to ${uncompressed}, not its diff_id ${layer.diffId}`);
  }
  if (expectedSize !== undefined && size !== expectedSize) {
    throw new LayerVerifyError(layer.digest, `layer ${layer.digest} is ${size} bytes, not the ${expectedSize} it had when it was verified`);
  }
}

/**
 * A stored layer's uncompressed size, with both of its digests checked. For a
 * layer whose size was not recorded when it was fetched, before it goes into
 * an archive, whose tar header must state it first.
 */
export async function measureLayer(layer: ArchiveLayerSource, limit = Number.MAX_SAFE_INTEGER): Promise<number> {
  let size = 0;
  for await (const chunk of verifiedLayer(layer, undefined, limit)) size += chunk.length;
  return size;
}

async function* archiveChunks(image: ArchiveInput): AsyncGenerator<Buffer> {
  const hex = (digest: string) => digest.slice('sha256:'.length);
  const seen = new Set<string>();
  const layers = image.layers.filter((layer) => {
    if (seen.has(layer.diffId)) return false;
    seen.add(layer.diffId);
    return true;
  });
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: { mediaType: OCI_CONFIG, digest: image.configDigest, size: image.config.length },
      layers: image.layers.map((l) => ({ mediaType: OCI_LAYER, digest: l.diffId, size: l.uncompressedSize })),
    })
  );
  const manifestDigest = sha256(manifest);
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [
        {
          mediaType: OCI_MANIFEST,
          digest: manifestDigest,
          size: manifest.length,
          annotations: { 'io.containerd.image.name': image.name },
        },
      ],
    })
  );
  const legacy = Buffer.from(
    JSON.stringify([
      {
        Config: `blobs/sha256/${hex(image.configDigest)}`,
        RepoTags: null,
        Layers: image.layers.map((l) => `blobs/sha256/${hex(l.diffId)}`),
      },
    ])
  );

  yield* fileEntry('oci-layout', Buffer.from(JSON.stringify({ imageLayoutVersion: '1.0.0' })));
  yield* fileEntry('index.json', index);
  yield* fileEntry('manifest.json', legacy);
  yield tarHeader('blobs/', 'dir', 0);
  yield tarHeader('blobs/sha256/', 'dir', 0);
  yield* fileEntry(`blobs/sha256/${hex(image.configDigest)}`, image.config);
  yield* fileEntry(`blobs/sha256/${hex(manifestDigest)}`, manifest);
  for (const layer of layers) {
    yield tarHeader(`blobs/sha256/${hex(layer.diffId)}`, 'file', layer.uncompressedSize);
    yield* verifiedLayer(layer, layer.uncompressedSize, layer.uncompressedSize);
    yield padding(layer.uncompressedSize);
  }
  yield Buffer.alloc(2 * BLOCK);
}

/** The archive as a stream; a layer that fails its check ends it with a LayerVerifyError. */
export function dockerArchive(image: ArchiveInput): Readable {
  return Readable.from(archiveChunks(image), { objectMode: false });
}
