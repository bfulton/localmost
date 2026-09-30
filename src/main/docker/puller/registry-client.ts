/**
 * The registry v2 client the puller runs on the Mac (contract §6.1).
 *
 * Electron main runs this with the user's full rights, on behalf of a job
 * whose policy names a registry, so everything the registry sends is hostile
 * input and every host it names is screened:
 *
 * - Only https, and only to hosts whose every address is public: a registry,
 *   token service or redirect target on loopback, the LAN or a link-local
 *   address is refused before any connection (the addresses are pinned, so a
 *   second resolution cannot move the connection).
 * - An Authorization header goes only to the origin it belongs to, and never
 *   on a redirect hop. Basic credentials go only to a screened https token
 *   service, only in the token request, never on a redirect of it. No
 *   cookies are ever sent. Only the registry's own challenge (a 401 from its
 *   origin, not from a redirect target) is ever answered.
 * - A token that expires mid-pull is renewed: a request answered 401 after a
 *   token was obtained runs the challenge again, once, and is retried.
 * - Redirects are followed, to https only, at most five hops.
 * - Every digest is checked against `sha256:<64 hex>` before it is used, and a
 *   manifest is identified by the hash of its bytes, never by the
 *   Docker-Content-Digest header.
 * - Answers that are parsed are bounded; blobs are streamed to the caller,
 *   which enforces their sizes.
 */

import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { app } from 'electron';
import { dnsLookup, HostLookup, isBlockedAddress, isLoopbackAddress, pinnedLookup } from '../../../shared/egress-screen';
import { DIGEST_RE } from '../../vm/paths';
import type { RegistryCredentials } from '../registry-auth';
import { cleanText } from './clean-text';

/** A pull failed; the message is for the job's log and the operator. */
export class PullError extends Error {
  /**
   * @param transient a dropped connection or a 5xx, which the puller retries
   *   once; never a refusal or a mismatch.
   */
  constructor(
    message: string,
    readonly transient = false
  ) {
    super(message);
    this.name = 'PullError';
  }
}

export const MANIFEST_TYPES = {
  ociIndex: 'application/vnd.oci.image.index.v1+json',
  ociManifest: 'application/vnd.oci.image.manifest.v1+json',
  dockerList: 'application/vnd.docker.distribution.manifest.list.v2+json',
  dockerManifest: 'application/vnd.docker.distribution.manifest.v2+json',
} as const;

const INDEX_TYPES: ReadonlySet<string> = new Set([MANIFEST_TYPES.ociIndex, MANIFEST_TYPES.dockerList]);
const IMAGE_MANIFEST_TYPES: ReadonlySet<string> = new Set([MANIFEST_TYPES.ociManifest, MANIFEST_TYPES.dockerManifest]);
const SCHEMA1_TYPES: ReadonlySet<string> = new Set([
  'application/vnd.docker.distribution.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v1+prettyjws',
]);
const CONFIG_TYPES: ReadonlySet<string> = new Set([
  'application/vnd.oci.image.config.v1+json',
  'application/vnd.docker.container.image.v1+json',
]);

/** The layer media types the puller loads, and how each is compressed. An allowlist. */
export const LAYER_TYPES: ReadonlyMap<string, 'none' | 'gzip' | 'zstd'> = new Map([
  ['application/vnd.oci.image.layer.v1.tar', 'none'],
  ['application/vnd.oci.image.layer.v1.tar+gzip', 'gzip'],
  ['application/vnd.oci.image.layer.v1.tar+zstd', 'zstd'],
  ['application/vnd.docker.image.rootfs.diff.tar.gzip', 'gzip'],
]);

/** Layers that live at a URL the image names, which Electron never fetches. */
function isForeignLayer(mediaType: string): boolean {
  return (
    mediaType === 'application/vnd.docker.image.rootfs.foreign.diff.tar.gzip' ||
    mediaType.startsWith('application/vnd.oci.image.layer.nondistributable.')
  );
}

/** What the Accept header offers: the four manifest types, never schema 1. */
const ACCEPT = [
  MANIFEST_TYPES.ociIndex,
  MANIFEST_TYPES.dockerList,
  MANIFEST_TYPES.ociManifest,
  MANIFEST_TYPES.dockerManifest,
].join(', ');

/** Docker's own limit on a manifest. */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_TOKEN_ANSWER_BYTES = 64 * 1024;
const MAX_REDIRECTS = 5;
const MAX_LAYERS = 256;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const PATH_COMPONENT_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;

const DOCKER_HUB_NAMES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

/**
 * The origin (scheme, host and port) of a registry's API: docker.io is served
 * by registry-1.docker.io; any other registry by its own name, over https.
 * Anything but a bare host[:port] is refused, which is what refuses an
 * `http:` registry.
 */
export function registryOrigin(registry: string): string {
  const name = String(registry).toLowerCase();
  if (DOCKER_HUB_NAMES.has(name)) return 'https://registry-1.docker.io';
  if (!name || /[/@?#\s\\]/.test(name)) {
    throw new PullError(`\`${cleanText(registry, 100)}\` is not a registry name; localmost pulls only from public https registries`);
  }
  let url: URL;
  try {
    url = new URL(`https://${name}`);
  } catch {
    throw new PullError(`\`${cleanText(registry, 100)}\` is not a registry name`);
  }
  return url.origin;
}

/** A repository path as the registry names it: `library/` for a single-name Docker Hub image. */
export function normalizeRepositoryPath(registry: string, repositoryPath: string): string {
  const pathName = DOCKER_HUB_NAMES.has(registry.toLowerCase()) && !repositoryPath.includes('/')
    ? `library/${repositoryPath}`
    : repositoryPath;
  if (pathName.length > 255 || !pathName.split('/').every((c) => PATH_COMPONENT_RE.test(c))) {
    throw new PullError(`\`${cleanText(repositoryPath, 300)}\` is not a repository name`);
  }
  return pathName;
}

export function isTag(reference: string): boolean {
  return TAG_RE.test(reference);
}

export function malformedDigest(ref: string): PullError {
  return new PullError(`the registry sent a malformed digest for ${ref}`);
}

/** A digest from outside Electron, checked before any use. */
export function checkDigest(value: unknown, ref: string): string {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) throw malformedDigest(ref);
  return value;
}

export interface ContentDescriptor {
  mediaType: string;
  digest: string;
  size: number;
}

export interface PlatformDescriptor extends ContentDescriptor {
  platform?: { architecture: string; os: string; variant?: string };
}

export type ManifestDocument =
  | { kind: 'index'; mediaType: string; manifests: PlatformDescriptor[] }
  | { kind: 'manifest'; mediaType: string; config: ContentDescriptor; layers: ContentDescriptor[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mediaTypeOf(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

function descriptor(value: unknown, ref: string): ContentDescriptor & { urls?: unknown } {
  if (!isRecord(value)) throw new PullError(`the registry sent a malformed manifest for ${ref}`);
  const digest = checkDigest(value.digest, ref);
  const size = value.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw new PullError(`the registry sent a malformed size for ${digest} in ${ref}`);
  }
  if (typeof value.mediaType !== 'string' || value.mediaType.length > 255) {
    throw new PullError(`the registry sent a descriptor with no media type for ${digest} in ${ref}`);
  }
  return { mediaType: value.mediaType, digest, size, urls: value.urls };
}

/**
 * Read a manifest or an index. Every digest is validated, schema 1 is refused,
 * and a layer that would have to be fetched from a URL the image names is
 * refused before anything is fetched. Layer and config types are allowlists.
 */
export function parseManifest(bytes: Buffer, contentType: string | undefined, ref: string): ManifestDocument {
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString('utf-8'));
  } catch {
    throw new PullError(`the registry sent a manifest for ${ref} that is not JSON`);
  }
  if (!isRecord(body)) throw new PullError(`the registry sent a malformed manifest for ${ref}`);
  const declared = typeof body.mediaType === 'string' ? body.mediaType : mediaTypeOf(contentType);
  if (body.schemaVersion === 1 || SCHEMA1_TYPES.has(declared)) {
    throw new PullError(`${ref} has a Docker schema 1 manifest, which localmost does not pull; push the image again with a current docker`);
  }
  if (body.schemaVersion !== 2) throw new PullError(`the registry sent a manifest for ${ref} that is not schema 2`);

  if (Array.isArray(body.manifests)) {
    const mediaType = declared || MANIFEST_TYPES.ociIndex;
    if (!INDEX_TYPES.has(mediaType)) throw new PullError(`${ref} is a ${cleanText(mediaType, 100)}, which localmost does not pull`);
    if (body.manifests.length > 1024) throw new PullError(`the index for ${ref} lists too many images`);
    const manifests = body.manifests.map((entry): PlatformDescriptor => {
      const d = descriptor(entry, ref);
      const platform = isRecord(entry) && isRecord(entry.platform) ? entry.platform : undefined;
      return {
        mediaType: d.mediaType,
        digest: d.digest,
        size: d.size,
        ...(platform && typeof platform.architecture === 'string' && typeof platform.os === 'string'
          ? {
              platform: {
                architecture: platform.architecture,
                os: platform.os,
                ...(typeof platform.variant === 'string' ? { variant: platform.variant } : {}),
              },
            }
          : {}),
      };
    });
    return { kind: 'index', mediaType, manifests };
  }

  const mediaType = declared || MANIFEST_TYPES.ociManifest;
  if (!IMAGE_MANIFEST_TYPES.has(mediaType) || !Array.isArray(body.layers)) {
    throw new PullError(`${ref} is a ${cleanText(mediaType || 'document', 100)}, which localmost does not pull`);
  }
  const config = descriptor(body.config, ref);
  if (!CONFIG_TYPES.has(config.mediaType)) {
    throw new PullError(`${ref} is not a container image: its config is a ${cleanText(config.mediaType, 100)}`);
  }
  if (body.layers.length > MAX_LAYERS) throw new PullError(`${ref} has more than ${MAX_LAYERS} layers`);
  const layers = body.layers.map((value): ContentDescriptor => {
    const layer = descriptor(value, ref);
    if (layer.urls !== undefined || isForeignLayer(layer.mediaType)) {
      throw new PullError(`image layer ${layer.digest} must be fetched from a URL the image names, which localmost does not do`);
    }
    if (!LAYER_TYPES.has(layer.mediaType)) {
      throw new PullError(`image layer ${layer.digest} has media type ${cleanText(layer.mediaType, 100)}, which localmost does not load`);
    }
    return { mediaType: layer.mediaType, digest: layer.digest, size: layer.size };
  });
  return { kind: 'manifest', mediaType, config: { mediaType: config.mediaType, digest: config.digest, size: config.size }, layers };
}

export interface ImageConfig {
  architecture: string;
  os: string;
  variant?: string;
  diffIds: string[];
}

/** Read an image config: its platform, and its diff_ids, validated, one for each layer. */
export function parseConfig(bytes: Buffer, layerCount: number, ref: string): ImageConfig {
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString('utf-8'));
  } catch {
    throw new PullError(`the image config of ${ref} is not JSON`);
  }
  if (!isRecord(body) || !isRecord(body.rootfs) || !Array.isArray(body.rootfs.diff_ids)) {
    throw new PullError(`the image config of ${ref} has no layer list`);
  }
  const diffIds = body.rootfs.diff_ids.map((d) => checkDigest(d, ref));
  if (diffIds.length !== layerCount) {
    throw new PullError(`the image config of ${ref} has ${diffIds.length} diff_ids for ${layerCount} layers`);
  }
  return {
    architecture: typeof body.architecture === 'string' ? body.architecture : '',
    os: typeof body.os === 'string' ? body.os : '',
    variant: typeof body.variant === 'string' ? body.variant : undefined,
    diffIds,
  };
}

/** Read a whole answer, up to a bound; past it, the connection is dropped. */
export function readBody(res: http.IncomingMessage, max: number, what: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) {
      res.destroy();
      reject(new PullError(`the registry sent a ${what} larger than ${max} bytes`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        res.destroy();
        reject(new PullError(`the registry sent a ${what} larger than ${max} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', (error) => reject(toPullError(error, what)));
    res.on('aborted', () => reject(new PullError(`the connection closed while reading a ${what}`, true)));
  });
}

function drain(res: http.IncomingMessage): void {
  res.resume();
  res.on('error', () => {
    // Nothing to report: the answer was already judged by its status.
  });
}

function toPullError(error: unknown, what: string): PullError {
  if (error instanceof PullError) return error;
  const e = error as NodeJS.ErrnoException;
  if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') return new PullError('the pull was cancelled');
  return new PullError(`could not fetch the ${what}: ${cleanText(e?.message ?? String(error), 200)}`, true);
}

/** The registry's own words for an error answer: `code: message`, as the docker CLI prints them. */
async function registryErrorText(res: http.IncomingMessage): Promise<string> {
  try {
    const body = JSON.parse((await readBody(res, MAX_ERROR_BYTES, 'error')).toString('utf-8')) as unknown;
    if (isRecord(body) && Array.isArray(body.errors) && isRecord(body.errors[0])) {
      const first = body.errors[0];
      const code = typeof first.code === 'string' ? first.code.toLowerCase().replace(/_/g, ' ') : '';
      const message = typeof first.message === 'string' ? first.message : '';
      return cleanText([code, message].filter(Boolean).join(': '), 300);
    }
  } catch {
    // Not the registry error shape: the status says enough.
  }
  return '';
}

interface Challenge {
  scheme: 'bearer' | 'basic';
  params: Record<string, string>;
}

function parseChallenge(header: string | string[] | undefined): Challenge | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^\s*(Bearer|Basic)\b(.*)$/i.exec(value);
  if (!match) return null;
  const params: Record<string, string> = {};
  const re = /([A-Za-z_]+)\s*=\s*(?:"([^"]*)"|([^\s,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(match[2])) !== null) params[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
  return { scheme: match[1].toLowerCase() as 'bearer' | 'basic', params };
}

export interface RegistryClientOptions {
  /** Resolves a host; every address it returns is screened. */
  lookup?: HostLookup;
  /** The operator's credentials for a registry (resolveRegistryCredentials). Anonymous when absent. */
  credentials?: (registry: string) => Promise<RegistryCredentials | undefined>;
  /**
   * Extra trusted certificates. Tests only, and refused in a packaged app:
   * production trusts Node's bundled roots.
   */
  ca?: string | Buffer | Array<string | Buffer>;
  /**
   * Tests only, and refused in a packaged app: where to connect for an
   * address that passed the screen. The mock registry's names resolve to
   * public TEST-NET addresses so that they pass, and this sends the
   * connection to the mock. Production passes neither this nor `ca`.
   */
  connectTo?: (address: string, port: number) => { address: string; port: number };
  /** Idle time on a connection before it is dropped. */
  idleTimeoutMs?: number;
}

export interface ImageLocation {
  registry: string;
  repositoryPath: string;
}

interface RequestOptions {
  method: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  body?: Buffer;
  /** Sent only on the first request, and only when its origin is this one. */
  authorization?: { origin: string; value: string };
  redirects: 'follow' | 'refuse';
  signal?: AbortSignal;
}

/** An answer, where it came from, and how many redirects led there: 0 when it came from the URL asked for. */
export interface Answered {
  res: http.IncomingMessage;
  url: URL;
  hops: number;
}

/** One manifest as fetched: its bytes, what they hash to, and the header's claim. */
export interface FetchedManifest {
  bytes: Buffer;
  digest: string;
  mediaType: string;
  /** Docker-Content-Digest, validated when present; a hint, never an identity. */
  headerDigest?: string;
}

export class RegistryClient {
  private readonly lookup: HostLookup;
  private readonly agent: https.Agent;

  constructor(private readonly options: RegistryClientOptions = {}) {
    // They undo the address screen and the TLS roots. Checked against
    // app.isPackaged, not NODE_ENV, which a packaged app's environment can set.
    if (app.isPackaged && (options.connectTo !== undefined || options.ca !== undefined)) {
      throw new Error('connectTo and ca are test-only options of the registry client');
    }
    this.lookup = options.lookup ?? dnsLookup;
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
  }

  /**
   * A session for one repository: `operator` authenticates with the
   * operator's credentials, if any; `anonymous` never does. Resolving the
   * credentials happens here, so a broken credential helper fails the pull
   * before anything is fetched.
   */
  async open(location: ImageLocation, mode: 'operator' | 'anonymous' = 'operator', signal?: AbortSignal): Promise<RegistrySession> {
    const origin = registryOrigin(location.registry);
    const repositoryPath = normalizeRepositoryPath(location.registry, location.repositoryPath);
    const credentials =
      mode === 'operator' && this.options.credentials ? await this.options.credentials(location.registry) : undefined;
    return new RegistrySession(this, origin, location.registry, repositoryPath, credentials, signal);
  }

  close(): void {
    this.agent.destroy();
  }

  /** Every address `host` resolves to, if all are public; otherwise a PullError naming the address. */
  async screen(host: string, describe: string): Promise<string[]> {
    let addresses: string[];
    if (net.isIP(host)) {
      addresses = [host];
    } else {
      try {
        addresses = await this.lookup(host);
      } catch {
        throw new PullError(`${describe} could not be resolved`);
      }
    }
    if (addresses.length === 0) throw new PullError(`${describe} could not be resolved`);
    const refused = addresses.find((a) => isBlockedAddress(a) || isLoopbackAddress(a));
    if (refused !== undefined) {
      throw new PullError(`${describe} resolves to a private address (${refused}); localmost pulls only from public https registries`);
    }
    return addresses;
  }

  /**
   * One request, following redirects when allowed: https only, each hop
   * screened, at most five. The authorization goes on the first request
   * only, and only to its own origin; no hop carries it or a cookie.
   */
  async request(start: URL, options: RequestOptions, describe: (url: URL, hop: number) => string): Promise<Answered> {
    let url = start;
    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'https:') {
        throw new PullError(`the registry redirected to ${cleanText(url.href, 200)}; localmost follows only https redirects`);
      }
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      if (hop === 0 && options.authorization && url.origin === options.authorization.origin) {
        headers.authorization = options.authorization.value;
      }
      const res = await this.send(url, options.method, headers, hop === 0 ? options.body : undefined, describe(url, hop), options.signal);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        drain(res);
        if (options.redirects === 'refuse') {
          throw new PullError(`${describe(url, hop)} redirected the token request; localmost sends credentials only to the service itself`);
        }
        if (hop >= MAX_REDIRECTS) throw new PullError(`the registry sent more than ${MAX_REDIRECTS} redirects`);
        try {
          url = new URL(res.headers.location, url);
        } catch {
          throw new PullError('the registry sent a redirect that is not a URL');
        }
        continue;
      }
      return { res, url, hops: hop };
    }
  }

  private async send(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
    describe: string,
    signal: AbortSignal | undefined
  ): Promise<http.IncomingMessage> {
    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    const port = Number(url.port || 443);
    const screened = await this.screen(hostname, describe);
    const targets = screened.map((address) => this.options.connectTo?.(address, port) ?? { address, port });
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: hostname,
          port: targets[0].port,
          servername: net.isIP(hostname) ? undefined : hostname,
          method,
          path: `${url.pathname}${url.search}`,
          headers: { host: url.host, 'user-agent': 'localmost', ...headers },
          lookup: pinnedLookup(targets.map((t) => t.address)),
          ca: this.options.ca,
          agent: this.agent,
          signal,
          timeout: this.options.idleTimeoutMs ?? 60_000,
        },
        resolve
      );
      req.on('error', (error) => reject(toPullError(error, `answer from ${url.host}`)));
      req.on('timeout', () => req.destroy(new PullError(`${url.host} stopped answering`, true)));
      req.end(body);
    });
  }
}

/** One repository on one registry, with the token its challenge asked for. */
export class RegistrySession {
  /** Whether the operator's credentials were sent (to the token service, or to a registry that asked). */
  usedCredentials = false;
  private authorization: string | undefined;

  constructor(
    private readonly client: RegistryClient,
    readonly origin: string,
    readonly registry: string,
    readonly repositoryPath: string,
    private readonly credentials: RegistryCredentials | undefined,
    private readonly signal: AbortSignal | undefined
  ) {}

  /** Whether this session holds the operator's credentials, whether or not it has sent them yet. */
  get hasCredentials(): boolean {
    return this.credentials !== undefined;
  }

  /** How the docker CLI would name a reference in this repository. */
  describe(reference: string): string {
    return `${this.registry}/${this.repositoryPath}${reference.startsWith('sha256:') ? '@' : ':'}${reference}`;
  }

  private checkReference(reference: string): void {
    if (isTag(reference)) return;
    checkDigest(reference, this.describe(cleanText(reference, 100)));
  }

  private basicAuthorization(credentials: { username: string; password: string }): string {
    return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  }

  /** Whether answering a challenge would change what the retried request sends. */
  private canAnswer(challenge: Challenge): boolean {
    if (challenge.scheme === 'bearer') return true;
    return this.credentials?.kind === 'basic' && this.authorization !== this.basicAuthorization(this.credentials);
  }

  /**
   * A request to the registry's own API. A 401 from the registry's origin is
   * answered once per request: the first time for the session's token, and
   * again whenever that token has expired. A 401 from a redirect target is
   * never answered, because its challenge names a realm the target chose
   * (§6.1): it fails the request.
   */
  private async api(method: 'GET' | 'HEAD', apiPath: string, accept?: string): Promise<http.IncomingMessage> {
    const url = new URL(`/v2/${this.repositoryPath}/${apiPath}`, this.origin);
    const headers: Record<string, string> = accept ? { accept } : {};
    const describe = (target: URL, hop: number) =>
      hop === 0 ? `registry \`${this.registry}\`` : `\`${target.host}\` (where the registry redirected)`;
    for (let answered = false; ; answered = true) {
      const { res, url: from, hops } = await this.client.request(
        url,
        {
          method,
          headers,
          authorization: this.authorization ? { origin: this.origin, value: this.authorization } : undefined,
          redirects: 'follow',
          signal: this.signal,
        },
        describe
      );
      if (res.statusCode !== 401) return res;
      if (hops > 0) {
        drain(res);
        throw new PullError(
          `${describe(from, hops)} answered 401; localmost answers only the registry's own challenge`
        );
      }
      const challenge = parseChallenge(res.headers['www-authenticate']);
      if (answered || !challenge || !this.canAnswer(challenge)) return res;
      drain(res);
      await this.authenticate(challenge);
    }
  }

  private async authenticate(challenge: Challenge): Promise<void> {
    if (challenge.scheme === 'basic') {
      if (this.credentials?.kind === 'basic') {
        this.usedCredentials = true;
        this.authorization = this.basicAuthorization(this.credentials);
      }
      return;
    }
    const realmText = challenge.params.realm ?? '';
    let realm: URL;
    try {
      realm = new URL(realmText);
    } catch {
      throw new PullError(`the registry's token service ${cleanText(realmText, 200)} is not a public https URL`);
    }
    const notPublic = new PullError(`the registry's token service ${cleanText(realm.href, 200)} is not a public https URL`);
    if (realm.protocol !== 'https:' || realm.username || realm.password) throw notPublic;
    try {
      await this.client.screen(realm.hostname.replace(/^\[|\]$/g, ''), `token service ${realm.host}`);
    } catch {
      throw notPublic;
    }
    const scope = `repository:${this.repositoryPath}:pull`;
    const service = challenge.params.service;
    let answer: Answered;
    const describe = () => `the registry's token service ${realm.host}`;
    if (this.credentials?.kind === 'identity-token') {
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.credentials.token,
        client_id: 'localmost',
        scope,
        ...(service ? { service } : {}),
      });
      this.usedCredentials = true;
      answer = await this.client.request(
        realm,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: Buffer.from(form.toString()),
          redirects: 'refuse',
          signal: this.signal,
        },
        describe
      );
    } else {
      const url = new URL(realm.href);
      if (service) url.searchParams.set('service', service);
      url.searchParams.set('scope', scope);
      let authorization: { origin: string; value: string } | undefined;
      if (this.credentials?.kind === 'basic') {
        this.usedCredentials = true;
        authorization = { origin: url.origin, value: this.basicAuthorization(this.credentials) };
      }
      answer = await this.client.request(url, { method: 'GET', authorization, redirects: 'refuse', signal: this.signal }, describe);
    }
    const res = answer.res;
    if (res.statusCode !== 200) {
      const text = await registryErrorText(res);
      throw new PullError(
        this.credentials
          ? `${this.registry} refused the credentials from ~/.docker/config.json${text ? `: ${text}` : ''}`
          : `${this.registry}'s token service refused an anonymous token${text ? `: ${text}` : ''}`
      );
    }
    let body: unknown;
    try {
      body = JSON.parse((await readBody(res, MAX_TOKEN_ANSWER_BYTES, 'token')).toString('utf-8'));
    } catch (error) {
      if (error instanceof PullError) throw error;
      throw new PullError(`${this.registry}'s token service sent an answer that is not JSON`);
    }
    const token = isRecord(body) ? (body.token ?? body.access_token) : undefined;
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(token)) {
      throw new PullError(`${this.registry}'s token service sent no usable token`);
    }
    this.authorization = `Bearer ${token}`;
  }

  /** Turn an answer that is not a success into the docker CLI's wording. */
  private async failure(res: http.IncomingMessage, reference: string, what: 'manifest' | 'blob'): Promise<PullError> {
    const status = res.statusCode ?? 0;
    const text = await registryErrorText(res);
    const ref = this.describe(reference);
    if (status === 429) {
      return new PullError(text || 'toomanyrequests: the registry refused the pull: too many requests');
    }
    if (status === 401 || status === 403) {
      return new PullError(
        `pull access denied for ${this.registry}/${this.repositoryPath}, repository does not exist or may require authorization${text ? `: ${text}` : ''}`
      );
    }
    if (status === 404) {
      return new PullError(
        what === 'manifest' ? `manifest for ${ref} not found${text ? `: ${text}` : ''}` : `blob ${reference} of ${this.registry}/${this.repositoryPath} not found`
      );
    }
    return new PullError(`${this.registry} answered ${status} for the ${what} of ${ref}${text ? `: ${text}` : ''}`, status >= 500);
  }

  /**
   * The digest a reference resolves to now, from a manifest HEAD (which
   * Docker Hub does not count against the pull limit), or null when the
   * registry has no such manifest. The header is validated but is only a
   * hint: whatever is used is hashed.
   */
  async head(reference: string): Promise<{ digest?: string } | null> {
    this.checkReference(reference);
    const res = await this.api('HEAD', `manifests/${reference}`, ACCEPT);
    if (res.statusCode === 404) {
      drain(res);
      return null;
    }
    if (res.statusCode !== 200) throw await this.failure(res, reference, 'manifest');
    drain(res);
    const header = res.headers['docker-content-digest'];
    if (header === undefined) return {};
    return { digest: checkDigest(header, this.describe(reference)) };
  }

  /** Whether the registry serves a manifest to this session: a HEAD answering 200. */
  async serves(reference: string): Promise<boolean> {
    this.checkReference(reference);
    const res = await this.api('HEAD', `manifests/${reference}`, ACCEPT);
    drain(res);
    return res.statusCode === 200;
  }

  async manifest(reference: string): Promise<FetchedManifest> {
    this.checkReference(reference);
    const res = await this.api('GET', `manifests/${reference}`, ACCEPT);
    if (res.statusCode !== 200) throw await this.failure(res, reference, 'manifest');
    const header = res.headers['docker-content-digest'];
    const headerDigest = header === undefined ? undefined : checkDigest(header, this.describe(reference));
    const bytes = await readBody(res, MAX_MANIFEST_BYTES, 'manifest');
    return {
      bytes,
      digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      mediaType: mediaTypeOf(res.headers['content-type']),
      headerDigest,
    };
  }

  /** A blob's bytes as a stream, after any redirects. The caller checks size and digest. */
  async blob(digest: string): Promise<http.IncomingMessage> {
    checkDigest(digest, this.describe(cleanText(digest, 100)));
    const res = await this.api('GET', `blobs/${digest}`);
    if (res.statusCode !== 200) throw await this.failure(res, digest, 'blob');
    return res;
  }
}
