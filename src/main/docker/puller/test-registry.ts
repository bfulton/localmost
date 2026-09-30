/**
 * A mock OCI registry for the puller's tests (contract §8): an HTTPS server
 * on 127.0.0.1 that answers as several hosts - the registry, its token
 * service and a CDN it redirects blobs to - with bearer-token auth,
 * manifests, blobs, and switches for the ways a registry can misbehave.
 *
 * The client under test screens every host the way it does in production, so
 * the names resolve (through `lookup`) to TEST-NET addresses, which pass the
 * screen, and `connectTo` then sends the connection to this server. A name
 * that resolves to a private or loopback address is refused before any
 * connection, as it would be for a real one.
 *
 * Test-only: nothing in the app imports it.
 */

import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import type { Duplex } from 'stream';
import type { HostLookup } from '../../../shared/egress-screen';

export const REGISTRY_HOST = 'registry.test';
export const AUTH_HOST = 'auth.test';
export const CDN_HOST = 'cdn.test';

/** Every name the server's certificate covers; each resolves to a public-looking TEST-NET address. */
const PUBLIC_NAMES: Record<string, string> = {
  [REGISTRY_HOST]: '203.0.113.10',
  [AUTH_HOST]: '203.0.113.11',
  [CDN_HOST]: '203.0.113.12',
  'cdn2.test': '203.0.113.13',
  'other.test': '203.0.113.14',
};

/** Names that resolve where no registry may be. */
const PRIVATE_NAMES: Record<string, string> = {
  'lan.test': '10.0.0.5',
  'loop.test': '127.0.0.1',
  'linklocal.test': '169.254.169.254',
};

export const MEDIA = {
  ociIndex: 'application/vnd.oci.image.index.v1+json',
  ociManifest: 'application/vnd.oci.image.manifest.v1+json',
  ociConfig: 'application/vnd.oci.image.config.v1+json',
  ociLayer: 'application/vnd.oci.image.layer.v1.tar',
  ociLayerGzip: 'application/vnd.oci.image.layer.v1.tar+gzip',
  ociLayerZstd: 'application/vnd.oci.image.layer.v1.tar+zstd',
  dockerList: 'application/vnd.docker.distribution.manifest.list.v2+json',
  dockerManifest: 'application/vnd.docker.distribution.manifest.v2+json',
  dockerConfig: 'application/vnd.docker.container.image.v1+json',
  dockerLayer: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
  dockerForeign: 'application/vnd.docker.image.rootfs.foreign.diff.tar.gzip',
  ociNondistributable: 'application/vnd.oci.image.layer.nondistributable.v1.tar+gzip',
  schema1: 'application/vnd.docker.distribution.manifest.v1+prettyjws',
} as const;

export const sha256 = (bytes: Buffer): string => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

/** A deterministic ustar archive of regular files. */
export function tarOf(files: Array<{ name: string; content: Buffer | string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content);
    const header = Buffer.alloc(512);
    header.write(file.name, 0, 100, 'utf-8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export type Compression = 'gzip' | 'zstd' | 'none';

export function compress(bytes: Buffer, compression: Compression): Buffer {
  if (compression === 'gzip') return zlib.gzipSync(bytes, { level: 1 });
  if (compression === 'zstd') return zlib.zstdCompressSync(bytes);
  return bytes;
}

export interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
  urls?: string[];
  platform?: { architecture: string; os: string; variant?: string };
  annotations?: Record<string, string>;
}

/** One single-platform image: its manifest, config and blobs, as a registry holds them. */
export interface BuiltImage {
  manifest: Buffer;
  manifestDigest: string;
  config: Buffer;
  configDigest: string;
  /** Compressed layer blobs, by digest. */
  blobs: Map<string, Buffer>;
  /** The uncompressed layer tars, in order, and their digests (the config's diff_ids). */
  layers: Buffer[];
  diffIds: string[];
  architecture: string;
}

export interface BuildImageOptions {
  /** Uncompressed layer tars; one small file by default. */
  layers?: Buffer[];
  compression?: Compression;
  architecture?: 'arm64' | 'amd64' | string;
  variant?: string;
  os?: string;
  /** Docker schema2 media types instead of OCI ones. */
  docker?: boolean;
  /** Anything to change in the config before it is serialised. */
  editConfig?: (config: Record<string, unknown>) => void;
  /** Anything to change in the manifest before it is serialised. */
  editManifest?: (manifest: { config: Descriptor; layers: Descriptor[] } & Record<string, unknown>) => void;
}

let imageCounter = 0;

export function buildImage(options: BuildImageOptions = {}): BuiltImage {
  const compression = options.compression ?? 'gzip';
  const layers = options.layers ?? [tarOf([{ name: `etc/image-${++imageCounter}`, content: `image ${imageCounter}\n` }])];
  const blobs = new Map<string, Buffer>();
  const layerDescriptors: Descriptor[] = layers.map((tar) => {
    const blob = compress(tar, compression);
    const digest = sha256(blob);
    blobs.set(digest, blob);
    const mediaType = options.docker
      ? MEDIA.dockerLayer
      : compression === 'gzip'
        ? MEDIA.ociLayerGzip
        : compression === 'zstd'
          ? MEDIA.ociLayerZstd
          : MEDIA.ociLayer;
    return { mediaType, digest, size: blob.length };
  });
  const diffIds = layers.map(sha256);
  const configObject: Record<string, unknown> = {
    architecture: options.architecture ?? 'arm64',
    os: options.os ?? 'linux',
    ...(options.variant ? { variant: options.variant } : {}),
    config: { Cmd: ['/bin/sh'] },
    rootfs: { type: 'layers', diff_ids: diffIds },
  };
  options.editConfig?.(configObject);
  const config = Buffer.from(JSON.stringify(configObject));
  const configDigest = sha256(config);
  const manifestObject = {
    schemaVersion: 2,
    mediaType: options.docker ? MEDIA.dockerManifest : MEDIA.ociManifest,
    config: { mediaType: options.docker ? MEDIA.dockerConfig : MEDIA.ociConfig, digest: configDigest, size: config.length },
    layers: layerDescriptors,
  };
  options.editManifest?.(manifestObject);
  const manifest = Buffer.from(JSON.stringify(manifestObject));
  blobs.set(configDigest, config);
  return {
    manifest,
    manifestDigest: sha256(manifest),
    config,
    configDigest,
    blobs,
    layers,
    diffIds,
    architecture: String(configObject.architecture),
  };
}

/** A multi-platform index over images, each tagged with its platform. */
export function buildIndex(
  entries: Array<{ image: BuiltImage; platform: Descriptor['platform']; mediaType?: string }>,
  options: { docker?: boolean; edit?: (index: { manifests: Descriptor[] } & Record<string, unknown>) => void } = {}
): { bytes: Buffer; digest: string } {
  const index = {
    schemaVersion: 2,
    mediaType: options.docker ? MEDIA.dockerList : MEDIA.ociIndex,
    manifests: entries.map(({ image, platform, mediaType }) => ({
      mediaType: mediaType ?? (options.docker ? MEDIA.dockerManifest : MEDIA.ociManifest),
      digest: image.manifestDigest,
      size: image.manifest.length,
      platform,
    })) as Descriptor[],
  };
  options.edit?.(index);
  const bytes = Buffer.from(JSON.stringify(index));
  return { bytes, digest: sha256(bytes) };
}

export interface RecordedRequest {
  host: string;
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
}

interface StoredManifest {
  bytes: Buffer;
  mediaType: string;
}

interface Repository {
  private: boolean;
  manifests: Map<string, StoredManifest>;
  blobs: Map<string, Buffer>;
}

/** The ways the registry can misbehave; each test sets what it needs. */
export interface RegistrySwitches {
  /** Where a blob request is redirected: a URL prefix the digest is appended to. */
  redirectBlobsTo?: string;
  /** Extra hops through the CDN before it serves the blob. */
  cdnHops?: number;
  /** The realm the registry names in its challenge. */
  realm?: string;
  /** The token service answers with a redirect to this URL. */
  tokenRedirect?: string;
  /** A Docker-Content-Digest to send instead of the real one. */
  contentDigestHeader?: string;
  /** Blobs to serve with one byte changed. */
  corruptBlobs?: Set<string>;
  /** Blobs to serve with extra bytes appended. */
  oversizeBlobs?: Set<string>;
  /** Answer every manifest request with 429 and Docker Hub's rate-limit error. */
  rateLimited?: boolean;
  /** Answer the registry's own requests with a challenge of this form instead of a bearer one. */
  basicChallenge?: boolean;
  /** Hold every blob response after its headers until this resolves. */
  holdBlobs?: Promise<void>;
}

function tokenFor(user: string | null, scope: string): string {
  return Buffer.from(JSON.stringify({ user, scope, nonce: crypto.randomBytes(4).toString('hex') })).toString('base64url');
}

function readToken(header: string | undefined): { user: string | null; scope: string } | null {
  if (!header?.startsWith('Bearer ')) return null;
  try {
    return JSON.parse(Buffer.from(header.slice(7), 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

let certCache: { key: string; cert: string } | null = null;

/** A self-signed certificate for every test name, made once per process with the system's openssl. */
function testCertificate(): { key: string; cert: string } {
  if (certCache) return certCache;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-registry-cert-'));
  try {
    const names = [...Object.keys(PUBLIC_NAMES), ...Object.keys(PRIVATE_NAMES)].map((n) => `DNS:${n}`).join(',');
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
        '-subj', '/CN=localmost test registry', '-addext', `subjectAltName=${names}`,
        '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' }
    );
    certCache = {
      key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf-8'),
      cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf-8'),
    };
    return certCache;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export class TestRegistry {
  readonly requests: RecordedRequest[] = [];
  readonly switches: RegistrySwitches = {};
  /** username → password, for the token service's basic auth. */
  readonly users = new Map<string, string>();
  /** Refresh tokens the token service accepts, and the user each stands for. */
  readonly refreshTokens = new Map<string, string>();
  private readonly repositories = new Map<string, Repository>();
  private readonly sockets = new Set<Duplex>();

  private constructor(
    private readonly server: https.Server,
    readonly port: number,
    readonly ca: string
  ) {}

  static async start(): Promise<TestRegistry> {
    const { key, cert } = testCertificate();
    let registry: TestRegistry | null = null;
    const server = https.createServer({ key, cert }, (req, res) => registry!.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    registry = new TestRegistry(server, (server.address() as net.AddressInfo).port, cert);
    server.on('connection', (socket) => {
      registry!.sockets.add(socket);
      socket.on('close', () => registry!.sockets.delete(socket));
    });
    return registry;
  }

  /** Resolves the test names: public ones to TEST-NET, the others to where no registry may be. */
  readonly lookup: HostLookup = async (host: string) => {
    const address = PUBLIC_NAMES[host] ?? PRIVATE_NAMES[host];
    if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return [address];
  };

  /** Sends a connection for a screened TEST-NET address to this server. */
  readonly connectTo = (address: string, port: number): { address: string; port: number } =>
    Object.values(PUBLIC_NAMES).includes(address) && port === 443 ? { address: '127.0.0.1', port: this.port } : { address, port };

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private repository(name: string): Repository {
    let repo = this.repositories.get(name);
    if (!repo) {
      repo = { private: false, manifests: new Map(), blobs: new Map() };
      this.repositories.set(name, repo);
    }
    return repo;
  }

  /** Make a repository need credentials: an anonymous token grants it nothing. */
  setPrivate(name: string, isPrivate = true): void {
    this.repository(name).private = isPrivate;
  }

  /** Store a manifest under its digest, and under `tag` when given. */
  putManifest(name: string, bytes: Buffer, mediaType: string, tag?: string): string {
    const repo = this.repository(name);
    const digest = sha256(bytes);
    repo.manifests.set(digest, { bytes, mediaType });
    if (tag) repo.manifests.set(tag, { bytes, mediaType });
    return digest;
  }

  putBlob(name: string, bytes: Buffer): string {
    const digest = sha256(bytes);
    this.repository(name).blobs.set(digest, bytes);
    return digest;
  }

  /** Store a built image: its manifest (tagged, when `tag` is given), config and layers. */
  putImage(name: string, image: BuiltImage, tag?: string): void {
    this.putManifest(name, image.manifest, JSON.parse(image.manifest.toString()).mediaType ?? MEDIA.ociManifest, tag);
    for (const [, blob] of image.blobs) this.putBlob(name, blob);
  }

  /** Store an index and every image under it; tag the index. */
  putIndex(name: string, index: { bytes: Buffer }, images: BuiltImage[], tag?: string, mediaType: string = MEDIA.ociIndex): void {
    for (const image of images) this.putImage(name, image);
    this.putManifest(name, index.bytes, mediaType, tag);
  }

  /** Requests to one host, optionally only those whose path starts with a prefix. */
  requestsTo(host: string, prefix = ''): RecordedRequest[] {
    return this.requests.filter((r) => r.host === host && r.path.startsWith(prefix));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    const url = new URL(req.url ?? '/', `https://${host}`);
    this.requests.push({ host, method: req.method ?? 'GET', path: url.pathname + url.search, headers: req.headers });
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (host === AUTH_HOST) this.token(req, res, url, body);
      else if (host === REGISTRY_HOST) this.api(req, res, url);
      else if (host === CDN_HOST || host === 'cdn2.test' || host === 'other.test') this.cdn(req, res, url);
      else this.send(res, 404, { errors: [{ code: 'NOT_FOUND', message: `unknown host ${host}` }] });
    });
  }

  private send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const bytes = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length), ...headers });
    res.end(bytes);
  }

  private token(req: http.IncomingMessage, res: http.ServerResponse, url: URL, body: Buffer): void {
    if (this.switches.tokenRedirect) {
      res.writeHead(307, { location: this.switches.tokenRedirect });
      res.end();
      return;
    }
    let user: string | null = null;
    let scope = url.searchParams.get('scope') ?? '';
    if (req.method === 'POST') {
      const form = new URLSearchParams(body.toString('utf-8'));
      scope = form.get('scope') ?? scope;
      const refresh = form.get('refresh_token');
      if (form.get('grant_type') !== 'refresh_token' || !refresh || !this.refreshTokens.has(refresh)) {
        this.send(res, 401, { errors: [{ code: 'UNAUTHORIZED', message: 'bad refresh token' }] });
        return;
      }
      user = this.refreshTokens.get(refresh)!;
    } else {
      const header = req.headers.authorization;
      if (header?.startsWith('Basic ')) {
        const [name, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf-8').split(':');
        if (this.users.get(name) !== rest.join(':')) {
          this.send(res, 401, { errors: [{ code: 'UNAUTHORIZED', message: 'incorrect username or password' }] });
          return;
        }
        user = name;
      }
    }
    this.send(res, 200, { token: tokenFor(user, scope), expires_in: 300 });
  }

  private challenge(res: http.ServerResponse, name: string): void {
    const realm = this.switches.realm ?? `https://${AUTH_HOST}/token`;
    const header = this.switches.basicChallenge
      ? `Basic realm="${REGISTRY_HOST}"`
      : `Bearer realm="${realm}",service="${REGISTRY_HOST}",scope="repository:${name}:pull"`;
    this.send(res, 401, { errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] }, { 'www-authenticate': header });
  }

  private authorized(req: http.IncomingMessage, repo: Repository, name: string): boolean {
    if (this.switches.basicChallenge) {
      const header = req.headers.authorization;
      if (!header?.startsWith('Basic ')) return false;
      const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf-8').split(':');
      return this.users.get(user) === rest.join(':');
    }
    const token = readToken(req.headers.authorization);
    if (!token || token.scope !== `repository:${name}:pull`) return false;
    return !repo.private || token.user !== null;
  }

  private api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    if (url.pathname.startsWith('/cdn/')) {
      // A redirect target on the registry's own origin.
      this.cdn(req, res, url);
      return;
    }
    if (url.pathname === '/v2/') {
      this.challenge(res, '');
      return;
    }
    const match = /^\/v2\/(.+)\/(manifests|blobs)\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      this.send(res, 404, { errors: [{ code: 'NOT_FOUND', message: 'not found' }] });
      return;
    }
    const [, name, kind, reference] = match;
    const repo = this.repositories.get(name);
    if (!repo || !this.authorized(req, repo, name)) {
      if (req.headers.authorization) {
        this.send(res, 401, {
          errors: [{ code: 'UNAUTHORIZED', message: 'authentication required', detail: [{ Type: 'repository', Name: name, Action: 'pull' }] }],
        });
      } else {
        this.challenge(res, name);
      }
      return;
    }
    if (kind === 'manifests') {
      if (this.switches.rateLimited) {
        this.send(res, 429, {
          errors: [{
            code: 'TOOMANYREQUESTS',
            message: 'You have reached your unauthenticated pull rate limit. https://www.docker.com/increase-rate-limit',
          }],
        });
        return;
      }
      const manifest = repo.manifests.get(decodeURIComponent(reference));
      if (!manifest) {
        this.send(res, 404, { errors: [{ code: 'MANIFEST_UNKNOWN', message: 'manifest unknown' }] });
        return;
      }
      res.writeHead(200, {
        'content-type': manifest.mediaType,
        'content-length': String(manifest.bytes.length),
        'docker-content-digest': this.switches.contentDigestHeader ?? sha256(manifest.bytes),
        'ratelimit-remaining': '100;w=21600',
      });
      res.end(req.method === 'HEAD' ? undefined : manifest.bytes);
      return;
    }
    const blob = repo.blobs.get(reference);
    if (!blob) {
      this.send(res, 404, { errors: [{ code: 'BLOB_UNKNOWN', message: 'blob unknown to registry' }] });
      return;
    }
    if (this.switches.redirectBlobsTo) {
      res.writeHead(307, {
        location: `${this.switches.redirectBlobsTo}${reference}?hops=${this.switches.cdnHops ?? 0}`,
        'set-cookie': 'registry-session=secret; Path=/; Secure',
      });
      res.end();
      return;
    }
    this.serveBlob(res, reference, blob);
  }

  private cdn(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const digest = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    const hops = Number(url.searchParams.get('hops') ?? '0');
    if (hops > 0) {
      res.writeHead(302, { location: `${url.origin}${url.pathname}?hops=${hops - 1}` });
      res.end();
      return;
    }
    for (const repo of this.repositories.values()) {
      const blob = repo.blobs.get(digest);
      if (blob) {
        this.serveBlob(res, digest, blob);
        return;
      }
    }
    this.send(res, 404, { errors: [{ code: 'BLOB_UNKNOWN', message: 'no such blob' }] });
  }

  private serveBlob(res: http.ServerResponse, digest: string, blob: Buffer): void {
    let bytes = blob;
    if (this.switches.corruptBlobs?.has(digest)) {
      bytes = Buffer.from(blob);
      bytes[bytes.length - 1] ^= 0xff;
    }
    if (this.switches.oversizeBlobs?.has(digest)) bytes = Buffer.concat([blob, Buffer.alloc(4096, 1)]);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) });
    const hold = this.switches.holdBlobs;
    if (hold) {
      res.flushHeaders();
      void hold.then(() => res.end(bytes));
    } else {
      res.end(bytes);
    }
  }
}
