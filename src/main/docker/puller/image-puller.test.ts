import { describe, it, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import type { DockerProgress, PullRequest } from '../docker-backend';
import { imageStoreDir, refsJsonPath, repoKeyOf, vmJobFiles } from '../../vm/paths';
import type { RosettaState } from '../../vm/types';
import { ImagePullerOptions, PullLimits, VmImagePuller, choosePlatform, parsePlatformRequest } from './image-puller';
import { RegistryClient, PullError } from './registry-client';
import type { RegistryCredentials } from '../registry-auth';
import { OVERSIZED } from './daemon-api';
import { ImageStore } from './image-store';
import { TestDaemon } from './test-daemon';
import { AUTH_HOST, MEDIA, REGISTRY_HOST, TestRegistry, buildImage, buildIndex, sha256, tarOf } from './test-registry';

// Held so a test can watch the listeners on the puller's gunzip stream while
// it writes: a wait for back-pressure that leaves its listeners behind piles
// them up, one per chunk.
const mockGunzipListeners = { most: 0 };
jest.mock('zlib', () => {
  const actual = jest.requireActual<typeof import('zlib')>('zlib');
  return {
    ...actual,
    createGunzip: (options?: import('zlib').ZlibOptions) => {
      const gunzip = actual.createGunzip(options);
      const write = gunzip.write.bind(gunzip) as (...args: unknown[]) => boolean;
      gunzip.write = ((...args: unknown[]) => {
        mockGunzipListeners.most = Math.max(mockGunzipListeners.most, gunzip.listenerCount('close'), gunzip.listenerCount('drain'));
        return write(...args);
      }) as typeof gunzip.write;
      return gunzip;
    },
  };
});

const REPOSITORY = 'octo/widgets';
const REPO_KEY = repoKeyOf(REPOSITORY);
const IMAGE = 'team/app';
const VM_ID = '3-0123456789ab';
const GiB = 1024 ** 3;

let registry: TestRegistry;
let daemon: TestDaemon;
let dataDir: string;
let notePulled: jest.Mock<(repoKey: string, configDigest: string) => void>;
let limits: PullLimits;
let free: number;
let credentials: RegistryCredentials | undefined;

beforeEach(async () => {
  registry = await TestRegistry.start();
  dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'image-puller-')));
  fs.mkdirSync(vmJobFiles(dataDir, VM_ID).dir, { recursive: true });
  daemon = await TestDaemon.start();
  notePulled = jest.fn();
  limits = { pullMaxGiB: 10, jobPullMaxGiB: 30, minFreeGiB: 20 };
  free = 500 * GiB;
  credentials = undefined;
});

afterEach(async () => {
  await daemon.close();
  await registry.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function puller(over: Partial<ImagePullerOptions> = {}): VmImagePuller {
  const client = new RegistryClient({
    lookup: registry.lookup,
    connectTo: registry.connectTo,
    ca: registry.ca,
    credentials: async () => credentials,
  });
  return new VmImagePuller({
    dataDir,
    client,
    cacheDisks: { notePulled },
    limits: () => limits,
    statfs: async () => ({ bavail: Math.floor(free / 4096), bsize: 4096 }),
    connectDaemon: daemon.connect,
    ...over,
  });
}

interface PullOver {
  request?: Partial<PullRequest>;
  rosetta?: RosettaState;
  socket?: string;
  signal?: AbortSignal;
  progress?: DockerProgress[];
}

function pull(p: VmImagePuller, over: PullOver = {}) {
  return p.pull({
    repository: REPOSITORY,
    request: { registry: REGISTRY_HOST, repositoryPath: IMAGE, tag: 'v1', ...over.request },
    rosetta: over.rosetta ?? 'ok',
    dockerSocketPath: over.socket ?? vmJobFiles(dataDir, VM_ID).dockerSocket,
    onProgress: (line) => over.progress?.push(line),
    signal: over.signal ?? new AbortController().signal,
  });
}

const publicBlobs = () => {
  const dir = path.join(imageStoreDir(dataDir, REPO_KEY), 'blobs', 'sha256');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};
const jobBlobs = () => {
  const dir = path.join(vmJobFiles(dataDir, VM_ID).blobStore, 'blobs', 'sha256');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};
const blobRequests = () => registry.requestsTo(REGISTRY_HOST).filter((r) => r.path.includes('/blobs/') && r.method === 'GET');
const layerOf = (image: ReturnType<typeof buildImage>) => [...image.blobs.keys()].find((d) => d !== image.configDigest)!;
const loadCalls = () => daemon.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/images/load'));

/** Until `condition` holds; the bound only matters when it never does. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(condition()).toBe(true);
}

/** The user a mock-registry bearer token stands for: null for an anonymous one, or no token at all. */
function bearerUser(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return (JSON.parse(Buffer.from(header.slice(7), 'base64url').toString('utf-8')) as { user: string | null }).user;
}

describe('a pull', () => {
  it('fetches, verifies, loads and tags an image, and reports it', async () => {
    const image = buildImage({ layers: [tarOf([{ name: 'a', content: 'one' }]), tarOf([{ name: 'b', content: 'two' }])] });
    registry.putImage(IMAGE, image, 'v1');
    const result = await pull(puller());
    expect(result).toEqual({
      manifestDigest: image.manifestDigest,
      configDigest: image.configDigest,
      platform: 'linux/arm64',
      source: 'registry',
    });
    expect(daemon.loads).toHaveLength(1);
    expect(daemon.loads[0].id).toBe(image.configDigest);
    for (const [i, layer] of image.layers.entries()) {
      expect(daemon.loads[0].entries.get(`blobs/sha256/${image.diffIds[i].slice(7)}`)).toEqual(layer);
    }
    expect(JSON.parse(daemon.loads[0].entries.get('index.json')!.toString()).manifests[0].annotations).toEqual({
      'io.containerd.image.name': `${REGISTRY_HOST}/${IMAGE}@${image.manifestDigest}`,
    });
    expect(daemon.calls).toContainEqual({
      method: 'POST',
      path: `/images/${image.configDigest}/tag?repo=${encodeURIComponent(`${REGISTRY_HOST}/${IMAGE}`)}&tag=v1`,
    });
    expect(daemon.images.get(image.configDigest)).toEqual([`${REGISTRY_HOST}/${IMAGE}:v1`]);
  });

  it("reports progress in Docker's shape", async () => {
    const image = buildImage({ layers: [tarOf([{ name: 'big', content: Buffer.alloc(300_000, 'x') }])] });
    registry.putImage(IMAGE, image, 'v1');
    const progress: DockerProgress[] = [];
    await pull(puller(), { progress });
    const allowed = new Set(['status', 'id', 'progress', 'progressDetail']);
    for (const line of progress) {
      for (const key of Object.keys(line)) expect(allowed.has(key)).toBe(true);
      expect(typeof line.status).toBe('string');
    }
    const layerId = [...image.blobs.keys()].find((d) => d !== image.configDigest)!.slice(7, 19);
    expect(progress[0]).toEqual({ status: `Pulling from ${IMAGE}`, id: 'v1' });
    expect(progress).toContainEqual({ status: 'Pulling fs layer', id: layerId });
    const downloading = progress.filter((p) => p.status === 'Downloading');
    expect(downloading.length).toBeGreaterThan(0);
    expect(downloading[0]).toEqual({
      status: 'Downloading',
      id: layerId,
      progress: expect.stringMatching(/^\[[=> ]{50}\] +[\d.]+[kMG]?B\/[\d.]+[kMG]?B$/),
      progressDetail: { current: expect.any(Number), total: expect.any(Number) },
    });
    expect(progress).toContainEqual({ status: 'Download complete', id: layerId });
    expect(progress).toContainEqual({ status: 'Pull complete', id: layerId });
    expect(progress[progress.length - 2]).toEqual({ status: `Digest: ${image.manifestDigest}` });
    expect(progress[progress.length - 1]).toEqual({ status: `Status: Downloaded newer image for ${REGISTRY_HOST}/${IMAGE}:v1` });
  });

  it('skips the load when the VM already has the image, and says so', async () => {
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    daemon.images.set(image.configDigest, []);
    const progress: DockerProgress[] = [];
    const result = await pull(puller(), { progress });
    expect(result.source).toBe('vm');
    expect(daemon.loads).toHaveLength(0);
    expect(daemon.calls).toContainEqual({ method: 'GET', path: `/images/${image.configDigest}/json` });
    expect(blobRequests().filter((r) => !r.path.endsWith(image.configDigest))).toHaveLength(0);
    expect(daemon.images.get(image.configDigest)).toEqual([`${REGISTRY_HOST}/${IMAGE}:v1`]);
    expect(progress[progress.length - 1]).toEqual({ status: `Status: Image is up to date for ${REGISTRY_HOST}/${IMAGE}:v1` });
  });

  it('serves a second pull from the store without fetching a blob', async () => {
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    await pull(puller());
    const before = blobRequests().length;
    const manifestGets = registry.requestsTo(REGISTRY_HOST, `/v2/${IMAGE}/manifests/`).filter((r) => r.method === 'GET').length;
    daemon.images.clear();
    const result = await pull(puller());
    expect(result.source).toBe('store');
    expect(blobRequests()).toHaveLength(before);
    // The tag was resolved again with a HEAD, and the manifest came from the store.
    expect(registry.requestsTo(REGISTRY_HOST, `/v2/${IMAGE}/manifests/`).filter((r) => r.method === 'GET')).toHaveLength(manifestGets);
    expect(daemon.loads).toHaveLength(2);
  });

  it('serves a pull by digest from the store without any request', async () => {
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    await pull(puller(), { request: { tag: undefined, digest: image.manifestDigest } });
    const before = registry.requests.length;
    daemon.images.clear();
    const result = await pull(puller(), { request: { tag: undefined, digest: image.manifestDigest } });
    expect(result.source).toBe('store');
    expect(registry.requests).toHaveLength(before);
  });

  it('requires a pull by digest to match the hash of the bytes fetched', async () => {
    const wanted = buildImage();
    const other = buildImage();
    registry.putImage(IMAGE, other);
    // The registry answers a request for one digest with another manifest.
    registry.putManifest(IMAGE, other.manifest, MEDIA.ociManifest, wanted.manifestDigest);
    await expect(pull(puller(), { request: { tag: undefined, digest: wanted.manifestDigest } })).rejects.toThrow(
      `the registry sent a manifest for ${REGISTRY_HOST}/${IMAGE}@${wanted.manifestDigest} whose digest is ${other.manifestDigest}`
    );
    expect(daemon.loads).toHaveLength(0);
  });

  it('identifies a tagged manifest by its bytes when Docker-Content-Digest disagrees', async () => {
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    registry.switches.contentDigestHeader = sha256(Buffer.from('a lie'));
    await expect(pull(puller())).resolves.toMatchObject({ manifestDigest: image.manifestDigest });
  });

  it('refuses a malformed digest in the request, the header, and the config before using it', async () => {
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    await expect(pull(puller(), { request: { tag: undefined, digest: 'sha256:../../../x' } })).rejects.toThrow(PullError);
    registry.switches.contentDigestHeader = 'sha256:../../x';
    await expect(pull(puller())).rejects.toThrow('the registry sent a malformed digest');
    registry.switches.contentDigestHeader = undefined;
    const bad = buildImage({ editConfig: (c) => { (c.rootfs as { diff_ids: string[] }).diff_ids[0] = 'sha256:../../../etc'; } });
    registry.putImage(IMAGE, bad, 'bad');
    await expect(pull(puller(), { request: { tag: 'bad' } })).rejects.toThrow('the registry sent a malformed digest');
    expect(fs.existsSync(path.join(dataDir, 'etc'))).toBe(false);
  });

  it('fails on a layer whose bytes do not match, naming the reference and both digests, and keeps nothing', async () => {
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    const layer = [...image.blobs.keys()].find((d) => d !== image.configDigest)!;
    registry.switches.corruptBlobs = new Set([layer]);
    const attempt = pull(puller());
    await expect(attempt).rejects.toThrow(`${REGISTRY_HOST}/${IMAGE}:v1`);
    await expect(pull(puller())).rejects.toThrow(`layer ${layer}`);
    expect(publicBlobs()).toEqual([]);
    // A mismatch is not retried.
    expect(blobRequests().filter((r) => r.path.endsWith(layer))).toHaveLength(2);
  });

  it('refuses a foreign layer, and a descriptor with urls, before fetching anything', async () => {
    const foreign = buildImage({ editManifest: (m) => { m.layers[0].mediaType = MEDIA.dockerForeign; } });
    const withUrls = buildImage({ editManifest: (m) => { m.layers[0].urls = ['https://cdn.test/layer']; } });
    registry.putImage(IMAGE, foreign, 'foreign');
    registry.putImage(IMAGE, withUrls, 'urls');
    await expect(pull(puller(), { request: { tag: 'foreign' } })).rejects.toThrow('must be fetched from a URL the image names');
    await expect(pull(puller(), { request: { tag: 'urls' } })).rejects.toThrow('must be fetched from a URL the image names');
    expect(blobRequests()).toHaveLength(0);
    expect(registry.requestsTo('cdn.test')).toHaveLength(0);
  });

  it('fails on a layer whose uncompressed bytes do not match its diff_id as it is fetched, before any load', async () => {
    const image = buildImage({ editConfig: (c) => { (c.rootfs as { diff_ids: string[] }).diff_ids[0] = sha256(Buffer.from('other')); } });
    registry.putImage(IMAGE, image, 'v1');
    await expect(pull(puller())).rejects.toThrow(
      `layer ${layerOf(image)} of ${REGISTRY_HOST}/${IMAGE}:v1 uncompresses to ${sha256(image.layers[0])}, not its diff_id ${sha256(Buffer.from('other'))}`
    );
    expect(publicBlobs()).toEqual([]);
    expect(jobBlobs()).toEqual([]);
    // Refused at fetch: the check as the archive streams never had to catch it.
    expect(loadCalls()).toHaveLength(0);
  });

  it('refuses a config whose bytes do not match its digest, before reading it', async () => {
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    registry.switches.corruptBlobs = new Set([image.configDigest]);
    const corrupted = Buffer.from(image.config);
    corrupted[corrupted.length - 1] ^= 0xff;
    await expect(pull(puller())).rejects.toThrow(
      `${REGISTRY_HOST} sent ${sha256(corrupted)} for the config ${image.configDigest} of ${REGISTRY_HOST}/${IMAGE}:v1`
    );
    expect(blobRequests().filter((r) => !r.path.endsWith(image.configDigest))).toHaveLength(0);
  });

  it('refuses an index entry whose manifest hashes to another digest', async () => {
    const wanted = buildImage({ architecture: 'arm64', variant: 'v8' });
    const other = buildImage({ architecture: 'arm64', variant: 'v8' });
    const index = buildIndex([{ image: wanted, platform: { architecture: 'arm64', os: 'linux', variant: 'v8' } }]);
    registry.putIndex(IMAGE, index, [wanted, other], 'v1');
    // Asked for the entry's digest, the registry sends another image's manifest.
    registry.putManifest(IMAGE, other.manifest, MEDIA.ociManifest, wanted.manifestDigest);
    await expect(pull(puller())).rejects.toThrow(`whose digest is ${other.manifestDigest}, not ${wanted.manifestDigest}`);
    expect(blobRequests()).toHaveLength(0);
    expect(loadCalls()).toHaveLength(0);
  });

  it('names the digest a pull by index digest asked for, and returns the config digest the image is found by', async () => {
    const image = buildImage({ architecture: 'arm64', variant: 'v8' });
    const index = buildIndex([{ image, platform: { architecture: 'arm64', os: 'linux', variant: 'v8' } }]);
    registry.putIndex(IMAGE, index, [image]);
    const result = await pull(puller(), { request: { tag: undefined, digest: index.digest } });
    expect(result).toMatchObject({ manifestDigest: image.manifestDigest, configDigest: image.configDigest, platform: 'linux/arm64/v8' });
    expect(JSON.parse(daemon.loads[0].entries.get('index.json')!.toString()).manifests[0].annotations).toEqual({
      'io.containerd.image.name': `${REGISTRY_HOST}/${IMAGE}@${index.digest}`,
    });
    // Untagged, as dockerd's classic store leaves a digest pull: found by its id, the config digest (§6.4).
    expect(daemon.images.get(result.configDigest)).toEqual([]);
    const refs = JSON.parse(fs.readFileSync(refsJsonPath(dataDir, REPO_KEY), 'utf-8')).refs;
    expect(refs).toEqual([expect.objectContaining({ ref: `${REGISTRY_HOST}/${IMAGE}@${index.digest}`, indexDigest: index.digest })]);
  });

  it('fetches again a stored layer that fails its check as it is loaded', async () => {
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    await pull(puller());
    const layer = layerOf(image);
    const file = path.join(imageStoreDir(dataDir, REPO_KEY), 'blobs', 'sha256', layer.slice(7));
    const altered = fs.readFileSync(file);
    altered[4] ^= 0xff; // the gzip mtime: still a valid stream of the same tar
    fs.writeFileSync(file, altered);
    daemon.images.clear();
    const fetched = blobRequests().filter((r) => r.path.endsWith(layer)).length;
    await expect(pull(puller())).resolves.toMatchObject({ source: 'registry', configDigest: image.configDigest });
    expect(blobRequests().filter((r) => r.path.endsWith(layer))).toHaveLength(fetched + 1);
    expect(fs.readFileSync(file)).toEqual(image.blobs.get(layer));
    expect(daemon.images.has(image.configDigest)).toBe(true);
  });

  it('fetches again a job-store layer that fails its check as it is measured', async () => {
    registry.users.set('me', 'pw');
    registry.setPrivate(IMAGE);
    credentials = { kind: 'basic', username: 'me', password: 'pw' };
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    await pull(puller());
    const layer = layerOf(image);
    const file = path.join(vmJobFiles(dataDir, VM_ID).blobStore, 'blobs', 'sha256', layer.slice(7));
    const altered = fs.readFileSync(file);
    altered[4] ^= 0xff;
    fs.writeFileSync(file, altered);
    daemon.images.clear();
    await expect(pull(puller())).resolves.toMatchObject({ source: 'registry', configDigest: image.configDigest });
    expect(fs.readFileSync(file)).toEqual(image.blobs.get(layer));
    expect(publicBlobs()).toEqual([]);
  });

  it('retries a dropped transfer once', async () => {
    const image = buildImage({ layers: [tarOf([{ name: 'x', content: Buffer.alloc(100_000, 'y') }])], compression: 'none' });
    registry.putImage(IMAGE, image, 'v1');
    const layer = [...image.blobs.keys()].find((d) => d !== image.configDigest)!;
    registry.switches.dropBlobsOnce = new Set([layer]);
    await expect(pull(puller())).resolves.toMatchObject({ source: 'registry' });
    expect(blobRequests().filter((r) => r.path.endsWith(layer))).toHaveLength(2);
  });

  it('renews an expired token partway through, as Docker does', async () => {
    const image = buildImage({ layers: ['a', 'b', 'c'].map((name) => tarOf([{ name, content: name.repeat(1000) }])) });
    registry.putImage(IMAGE, image, 'v1');
    // Each token is good for two requests: the pull's HEAD, GETs and three layers cross it twice.
    registry.switches.tokenMaxUses = 2;
    await expect(pull(puller())).resolves.toMatchObject({ source: 'registry', configDigest: image.configDigest });
    expect(registry.requestsTo(AUTH_HOST).length).toBeGreaterThanOrEqual(3);
  });

  it('streams a large layer without piling listeners on the decompressor', async () => {
    mockGunzipListeners.most = 0;
    // Random bytes do not compress: many chunks, and back-pressure on most.
    const image = buildImage({ layers: [tarOf([{ name: 'big', content: crypto.randomBytes(6 * 1024 * 1024) }])] });
    registry.putImage(IMAGE, image, 'v1');
    await pull(puller());
    expect(mockGunzipListeners.most).toBeGreaterThan(0);
    expect(mockGunzipListeners.most).toBeLessThan(5);
  });

  it('loads zstd and uncompressed layers as well as gzip', async () => {
    for (const [tag, compression] of [['z', 'zstd'], ['n', 'none']] as const) {
      const image = buildImage({ compression });
      registry.putImage(IMAGE, image, tag);
      await pull(puller(), { request: { tag } });
      expect(daemon.loads[daemon.loads.length - 1].entries.get(`blobs/sha256/${image.diffIds[0].slice(7)}`)).toEqual(image.layers[0]);
    }
  });

  it('refuses a daemon socket that is not a VM of this data directory', async () => {
    registry.putImage(IMAGE, buildImage(), 'v1');
    await expect(pull(puller(), { socket: path.join(dataDir, 'docker.sock') })).rejects.toThrow();
    await expect(pull(puller(), { socket: path.join(dataDir, 'vm', 'jobs', '..', 'x', 'docker.sock') })).rejects.toThrow();
    // Named like a VM's, but not where VmManager puts one.
    const elsewhere = path.join(dataDir, 'elsewhere', VM_ID, 'docker.sock');
    await expect(pull(puller(), { socket: elsewhere })).rejects.toThrow(`not a VM's docker socket: ${elsewhere}`);
    expect(registry.requests).toHaveLength(0);
    expect(fs.existsSync(path.join(dataDir, 'elsewhere'))).toBe(false);
  });

  it('makes every pull on a store wait for its first sweep', async () => {
    const publicRoot = imageStoreDir(dataDir, REPO_KEY);
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const swept: string[] = [];
    const sweep = jest.spyOn(ImageStore.prototype, 'sweepTemp').mockImplementation(async function (this: ImageStore) {
      swept.push(this.root);
      if (this.root === publicRoot) await gate;
    });
    try {
      registry.putImage(IMAGE, buildImage(), 'v1');
      const p = puller();
      const first = pull(p);
      const second = pull(p);
      await until(() => swept.includes(publicRoot));
      await new Promise((r) => setTimeout(r, 100));
      // Neither pull may write to the store while its sweep may still delete what it writes.
      expect(registry.requests).toHaveLength(0);
      open();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(swept.filter((root) => root === publicRoot)).toHaveLength(1);
    } finally {
      sweep.mockRestore();
    }
  });
});

describe('concurrency', () => {
  it("runs at most maxPullsPerVm of one VM's pulls at a time, and queues the rest", async () => {
    registry.putImage(IMAGE, buildImage(), 'v1');
    registry.putImage(IMAGE, buildImage(), 'v2');
    let release: () => void = () => undefined;
    registry.switches.holdBlobs = new Promise<void>((resolve) => (release = resolve));
    const p = puller({ maxPullsPerVm: 1 });
    const first = pull(p);
    const second = pull(p, { request: { tag: 'v2' } });
    await until(() => blobRequests().length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(registry.requestsTo(REGISTRY_HOST, `/v2/${IMAGE}/manifests/v2`)).toHaveLength(0);
    release();
    await expect(first).resolves.toMatchObject({ source: 'registry' });
    await expect(second).resolves.toMatchObject({ source: 'registry' });
  });

  it('caps pulls across every VM too', async () => {
    registry.putImage(IMAGE, buildImage(), 'v1');
    registry.putImage(IMAGE, buildImage(), 'v2');
    let release: () => void = () => undefined;
    registry.switches.holdBlobs = new Promise<void>((resolve) => (release = resolve));
    const p = puller({ maxPulls: 1 });
    const first = pull(p);
    const second = pull(p, { request: { tag: 'v2' }, socket: vmJobFiles(dataDir, '4-0123456789ac').dockerSocket });
    await until(() => blobRequests().length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(registry.requestsTo(REGISTRY_HOST, `/v2/${IMAGE}/manifests/v2`)).toHaveLength(0);
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('lets a queued pull be cancelled, and it holds no place in the queue', async () => {
    registry.putImage(IMAGE, buildImage(), 'v1');
    registry.putImage(IMAGE, buildImage(), 'v2');
    registry.putImage(IMAGE, buildImage(), 'v3');
    let release: () => void = () => undefined;
    registry.switches.holdBlobs = new Promise<void>((resolve) => (release = resolve));
    const p = puller({ maxPullsPerVm: 1 });
    const first = pull(p);
    const controller = new AbortController();
    const queued = pull(p, { request: { tag: 'v2' }, signal: controller.signal });
    const third = pull(p, { request: { tag: 'v3' } });
    await until(() => blobRequests().length > 0);
    controller.abort();
    await expect(queued).rejects.toThrow('cancelled');
    release();
    await expect(first).resolves.toBeTruthy();
    await expect(third).resolves.toBeTruthy();
    expect(registry.requestsTo(REGISTRY_HOST, `/v2/${IMAGE}/manifests/v2`)).toHaveLength(0);
  });
});

describe('which store (owner decision 1)', () => {
  it('keeps a public image in the repository store and notes it for the cache', async () => {
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    await pull(puller());
    expect(publicBlobs().sort()).toEqual(
      [image.manifestDigest, image.configDigest, ...image.blobs.keys()].map((d) => d.slice(7)).filter((d, i, a) => a.indexOf(d) === i).sort()
    );
    expect(jobBlobs()).toEqual([]);
    expect(notePulled).toHaveBeenCalledWith(REPO_KEY, image.configDigest);
    const refs = JSON.parse(fs.readFileSync(refsJsonPath(dataDir, REPO_KEY), 'utf-8'));
    expect(refs.refs).toEqual([
      expect.objectContaining({
        ref: `${REGISTRY_HOST}/${IMAGE}:v1`,
        platform: 'linux/arm64',
        manifestDigest: image.manifestDigest,
        configDigest: image.configDigest,
      }),
    ]);
  });

  it('keeps a public image pulled with credentials in the repository store too', async () => {
    registry.users.set('me', 'pw');
    credentials = { kind: 'basic', username: 'me', password: 'pw' };
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    await pull(puller());
    expect(publicBlobs().length).toBeGreaterThan(0);
    expect(notePulled).toHaveBeenCalledWith(REPO_KEY, image.configDigest);
  });

  it('keeps an image the registry refuses anonymously in the job store only, and never notes it', async () => {
    registry.users.set('me', 'pw');
    registry.setPrivate(IMAGE);
    credentials = { kind: 'basic', username: 'me', password: 'pw' };
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    const result = await pull(puller());
    expect(result.source).toBe('registry');
    expect(publicBlobs()).toEqual([]);
    expect(jobBlobs().length).toBeGreaterThan(0);
    expect(fs.existsSync(refsJsonPath(dataDir, REPO_KEY))).toBe(false);
    expect(notePulled).not.toHaveBeenCalled();
    expect(daemon.loads).toHaveLength(1);
    // The anonymous probe carried no credentials: its token was asked for
    // with no Authorization, and stands for no user. It is a GET, whose
    // bytes are hashed: a status alone is not evidence.
    const probes = registry.requestsTo(REGISTRY_HOST, `/v2/${IMAGE}/manifests/${image.manifestDigest}`).filter((r) => r.method === 'GET');
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) expect(bearerUser(probe.headers.authorization)).toBeNull();
    expect(probes.some((probe) => probe.headers.authorization?.startsWith('Bearer '))).toBe(true);
    const tokens = registry.requestsTo(AUTH_HOST);
    expect(tokens.filter((t) => t.headers.authorization === undefined).length).toBeGreaterThan(0);
  });

  it('keeps a private image out of the repository store when it is pulled again by digest, from the job store', async () => {
    registry.users.set('me', 'pw');
    registry.setPrivate(IMAGE);
    credentials = { kind: 'basic', username: 'me', password: 'pw' };
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    await pull(puller());
    // The job removes it (`docker rmi`), then pulls it by digest: the
    // manifest and config come from the job store, and nothing is sent.
    daemon.images.clear();
    const again = await pull(puller(), { request: { tag: undefined, digest: image.manifestDigest } });
    expect(again.source).toBe('store');
    expect(publicBlobs()).toEqual([]);
    expect(fs.existsSync(refsJsonPath(dataDir, REPO_KEY))).toBe(false);
    expect(notePulled).not.toHaveBeenCalled();
  });

  it('does not take a 200 to an anonymous HEAD as the registry serving the image', async () => {
    // A registry may answer 200 to every HEAD; only the manifest's bytes,
    // fetched anonymously and hashed, show that it serves the image.
    registry.users.set('me', 'pw');
    registry.setPrivate(IMAGE);
    registry.switches.headAnswersEverything = true;
    credentials = { kind: 'basic', username: 'me', password: 'pw' };
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    await pull(puller());
    expect(publicBlobs()).toEqual([]);
    expect(fs.existsSync(refsJsonPath(dataDir, REPO_KEY))).toBe(false);
    expect(notePulled).not.toHaveBeenCalled();
  });

  it('never promotes a private image that another repository names by its digest', async () => {
    // A private image, pulled with the operator's credentials, is in the job
    // store. The job then pulls its manifest digest from another repository, on a registry that
    // answers 200 to every HEAD: nothing need be fetched, and the manifest
    // and config would be read from the job store.
    registry.users.set('me', 'pw');
    registry.setPrivate(IMAGE);
    credentials = { kind: 'basic', username: 'me', password: 'pw' };
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    await pull(puller());
    credentials = undefined;
    registry.switches.headAnswersEverything = true;
    daemon.images.clear();
    await pull(puller(), { request: { registry: REGISTRY_HOST, repositoryPath: 'evil/x', tag: undefined, digest: image.manifestDigest } });
    // And by a tag whose HEAD names that digest.
    registry.switches.contentDigestHeader = image.manifestDigest;
    await pull(puller(), { request: { registry: REGISTRY_HOST, repositoryPath: 'evil/x', tag: 'latest' } });
    expect(publicBlobs()).toEqual([]);
    expect(fs.existsSync(refsJsonPath(dataDir, REPO_KEY))).toBe(false);
    expect(notePulled).not.toHaveBeenCalled();
  });

  it('never promotes a config read from the job store, even when another repository serves the manifest itself', async () => {
    // The manifest and the layers are public somewhere, but the config, with
    // its ENV, came from the private pull. The anonymous check passes for
    // the manifest; the config must still stay in the job store.
    registry.users.set('me', 'pw');
    registry.setPrivate(IMAGE);
    credentials = { kind: 'basic', username: 'me', password: 'pw' };
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    await pull(puller());
    credentials = undefined;
    registry.putManifest('evil/x', image.manifest, MEDIA.ociManifest);
    for (const [digest, bytes] of image.blobs) if (digest !== image.configDigest) registry.putBlob('evil/x', bytes);
    daemon.images.clear();
    await pull(puller(), { request: { registry: REGISTRY_HOST, repositoryPath: 'evil/x', tag: undefined, digest: image.manifestDigest } });
    expect(publicBlobs()).not.toContain(image.configDigest.slice(7));
    expect(publicBlobs()).not.toContain(image.manifestDigest.slice(7));
    expect(fs.existsSync(refsJsonPath(dataDir, REPO_KEY))).toBe(false);
    expect(notePulled).not.toHaveBeenCalled();
  });

  it('keeps it out even when the operator has no credentials by the second pull', async () => {
    registry.users.set('me', 'pw');
    registry.setPrivate(IMAGE);
    credentials = { kind: 'basic', username: 'me', password: 'pw' };
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    await pull(puller());
    credentials = undefined;
    daemon.images.clear();
    const again = await pull(puller(), { request: { tag: undefined, digest: image.manifestDigest } });
    expect(again.source).toBe('store');
    expect(publicBlobs()).toEqual([]);
    expect(fs.existsSync(refsJsonPath(dataDir, REPO_KEY))).toBe(false);
    expect(notePulled).not.toHaveBeenCalled();
  });
});

describe('platform choice', () => {
  const arm64 = buildImage({ architecture: 'arm64', variant: 'v8' });
  const amd64 = buildImage({ architecture: 'amd64' });
  const armv7 = buildImage({ architecture: 'arm', variant: 'v7' });

  function putMulti(entries: Array<{ image: ReturnType<typeof buildImage>; platform: { architecture: string; os: string; variant?: string } }>) {
    const index = buildIndex(entries);
    registry.putIndex(IMAGE, index, entries.map((e) => e.image), 'v1');
    return index;
  }

  it('prefers arm64, v8 first', async () => {
    const plain = buildImage({ architecture: 'arm64' });
    putMulti([
      { image: amd64, platform: { architecture: 'amd64', os: 'linux' } },
      { image: plain, platform: { architecture: 'arm64', os: 'linux' } },
      { image: arm64, platform: { architecture: 'arm64', os: 'linux', variant: 'v8' } },
    ]);
    await expect(pull(puller())).resolves.toMatchObject({ manifestDigest: arm64.manifestDigest, platform: 'linux/arm64/v8' });
  });

  it('takes amd64 when there is no arm64, or when it is asked for, under Rosetta', async () => {
    putMulti([
      { image: amd64, platform: { architecture: 'amd64', os: 'linux' } },
      { image: armv7, platform: { architecture: 'arm', os: 'linux', variant: 'v7' } },
    ]);
    await expect(pull(puller())).resolves.toMatchObject({ manifestDigest: amd64.manifestDigest, platform: 'linux/amd64' });
    putMulti([
      { image: arm64, platform: { architecture: 'arm64', os: 'linux', variant: 'v8' } },
      { image: amd64, platform: { architecture: 'amd64', os: 'linux' } },
    ]);
    await expect(pull(puller(), { request: { platform: 'linux/amd64' } })).resolves.toMatchObject({ platform: 'linux/amd64' });
  });

  it("gives the design's message when amd64 needs Rosetta and the VM has none", async () => {
    putMulti([{ image: amd64, platform: { architecture: 'amd64', os: 'linux' } }]);
    await expect(pull(puller(), { rosetta: 'absent' })).rejects.toThrow(
      `image \`${REGISTRY_HOST}/${IMAGE}:v1\` has no arm64 build, and amd64 images need Rosetta for Linux, which is not installed on this Mac (install it with \`softwareupdate --install-rosetta\`)`
    );
    await expect(pull(puller(), { rosetta: 'broken' })).rejects.toThrow(
      `image \`${REGISTRY_HOST}/${IMAGE}:v1\` has no arm64 build, and amd64 images need Rosetta for Linux, which failed its self-test in this job's Docker VM`
    );
    expect(blobRequests()).toHaveLength(0);
  });

  it('checks a single-platform manifest against its config', async () => {
    registry.putImage(IMAGE, amd64, 'v1');
    await expect(pull(puller(), { rosetta: 'absent' })).rejects.toThrow('has no arm64 build');
    await expect(pull(puller(), { rosetta: 'ok' })).resolves.toMatchObject({ platform: 'linux/amd64' });
    registry.putImage(IMAGE, armv7, 'v7');
    await expect(pull(puller(), { request: { tag: 'v7' } })).rejects.toThrow('linux/arm');
    registry.putImage(IMAGE, arm64, 'v8');
    await expect(pull(puller(), { request: { tag: 'v8', platform: 'linux/amd64' } })).rejects.toThrow('not the linux/amd64');
  });

  it('refuses a platform the VM does not run', () => {
    expect(() => parsePlatformRequest('linux/arm/v7')).toThrow('linux/arm64 and linux/amd64');
    expect(() => parsePlatformRequest('windows/amd64')).toThrow();
    expect(parsePlatformRequest('linux/amd64')).toEqual({ architecture: 'amd64' });
    expect(parsePlatformRequest('linux/arm64/v8')).toEqual({ architecture: 'arm64', variant: 'v8' });
    expect(parsePlatformRequest(undefined)).toBeUndefined();
  });

  it('chooses from an index without the network', () => {
    const d = (arch: string, variant?: string) => ({
      mediaType: MEDIA.ociManifest,
      digest: sha256(Buffer.from(arch + (variant ?? ''))),
      size: 1,
      platform: { architecture: arch, os: 'linux', ...(variant ? { variant } : {}) },
    });
    const attestation = { ...d('unknown'), platform: { architecture: 'unknown', os: 'unknown' } };
    expect(choosePlatform([attestation, d('amd64'), d('arm64', 'v8')], undefined, 'ok', 'x').platform).toBe('linux/arm64/v8');
    expect(() => choosePlatform([attestation, d('s390x')], undefined, 'ok', 'x')).toThrow('has no linux/arm64 or linux/amd64 build');
    expect(() => choosePlatform([d('amd64')], { architecture: 'arm64' }, 'ok', 'x')).toThrow('has no linux/arm64 build');
  });
});

describe('limits', () => {
  let bomb: Buffer;
  let bombTar: number;

  beforeAll(() => {
    // 80 MiB of zeros: gzip shrinks it about a thousandfold, so it expands past
    // 64 MiB plus 100 times its compressed size.
    const zeros = Buffer.alloc(80 * 1024 * 1024);
    bombTar = zeros.length;
    bomb = zlib.gzipSync(zeros, { level: 9 });
  });

  function assertNoBlobs(): void {
    expect(publicBlobs()).toEqual([]);
    expect(jobBlobs()).toEqual([]);
  }

  it('stops a pull past pullMaxGiB, before fetching what would not fit', async () => {
    const image = buildImage({ layers: [tarOf([{ name: 'x', content: Buffer.alloc(50_000, 'z') }])], compression: 'none' });
    registry.putImage(IMAGE, image, 'v1');
    limits = { ...limits, pullMaxGiB: 20_000 / GiB };
    await expect(pull(puller())).rejects.toThrow('(dockerVm.pullMaxGiB)');
    assertNoBlobs();
    // The descriptor's size said it would not fit, so it was never requested.
    const layer = [...image.blobs.keys()].find((d) => d !== image.configDigest)!;
    expect(blobRequests().filter((r) => r.path.endsWith(layer))).toHaveLength(0);
  });

  it("stops a job's pulls past jobPullMaxGiB", async () => {
    const first = buildImage({ layers: [tarOf([{ name: 'x', content: Buffer.alloc(30_000, 'a') }])], compression: 'none' });
    const second = buildImage({ layers: [tarOf([{ name: 'y', content: Buffer.alloc(30_000, 'b') }])], compression: 'none' });
    registry.putImage(IMAGE, first, 'v1');
    registry.putImage(IMAGE, second, 'v2');
    limits = { ...limits, jobPullMaxGiB: 50_000 / GiB };
    const p = puller();
    await pull(p);
    await expect(pull(p, { request: { tag: 'v2' } })).rejects.toThrow('(dockerVm.jobPullMaxGiB)');
    expect(publicBlobs()).not.toContain(second.diffIds[0].slice(7));
  });

  it("stops two pulls running at once in one job that together pass jobPullMaxGiB, as the bytes stream", async () => {
    const first = buildImage({ layers: [tarOf([{ name: 'x', content: Buffer.alloc(30_000, 'a') }])], compression: 'none' });
    const second = buildImage({ layers: [tarOf([{ name: 'y', content: Buffer.alloc(30_000, 'b') }])], compression: 'none' });
    registry.putImage(IMAGE, first, 'v1');
    registry.putImage(IMAGE, second, 'v2');
    limits = { ...limits, jobPullMaxGiB: 50_000 / GiB };
    // Each layer fits on its own, so both pass the check before their fetch; only the bytes can tell.
    const layers = [layerOf(first), layerOf(second)];
    let release: () => void = () => undefined;
    registry.switches.holdBlobs = new Promise<void>((resolve) => (release = resolve));
    registry.switches.holdOnly = new Set(layers);
    const p = puller();
    const outcomes = [pull(p), pull(p, { request: { tag: 'v2' } })].map((attempt) =>
      attempt.then(
        () => 'pulled',
        (error: Error) => error.message
      )
    );
    await until(() => layers.every((layer) => blobRequests().some((r) => r.path.endsWith(layer))));
    release();
    const results = await Promise.all(outcomes);
    expect(results.filter((r) => r === 'pulled')).toHaveLength(1);
    expect(results.find((r) => r !== 'pulled')).toContain('(dockerVm.jobPullMaxGiB)');
  });

  it('does not count what a dropped transfer took against the limits when it is retried', async () => {
    const image = buildImage({ layers: [tarOf([{ name: 'x', content: Buffer.alloc(100_000, 'y') }])], compression: 'none' });
    registry.putImage(IMAGE, image, 'v1');
    const layer = layerOf(image);
    registry.switches.dropBlobsOnce = new Set([layer]);
    // Room for the image once, not for it and half of it again.
    limits = { ...limits, pullMaxGiB: (image.blobs.get(layer)!.length + image.config.length + 1024) / GiB };
    await expect(pull(puller())).resolves.toMatchObject({ source: 'registry' });
    expect(blobRequests().filter((r) => r.path.endsWith(layer))).toHaveLength(2);
  });

  it('cuts off a blob that streams past its declared size', async () => {
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    const layer = [...image.blobs.keys()].find((d) => d !== image.configDigest)!;
    registry.switches.oversizeBlobs = new Set([layer]);
    await expect(pull(puller())).rejects.toThrow(`is larger than the ${image.blobs.get(layer)!.length} bytes its descriptor declares`);
    assertNoBlobs();
  });

  it('stops a layer that expands past 64 MiB plus 100 times its compressed size', async () => {
    const image = buildImage({ layers: [Buffer.alloc(bombTar)], compression: 'none' });
    // The same image, but its one layer is the gzip bomb (and its diff_id what the zeros hash to).
    const bombDigest = sha256(bomb);
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: MEDIA.ociManifest,
        config: { mediaType: MEDIA.ociConfig, digest: image.configDigest, size: image.config.length },
        layers: [{ mediaType: MEDIA.ociLayerGzip, digest: bombDigest, size: bomb.length }],
      })
    );
    registry.putManifest(IMAGE, manifest, MEDIA.ociManifest, 'v1');
    registry.putBlob(IMAGE, image.config);
    registry.putBlob(IMAGE, bomb);
    const limit = 64 * 1024 * 1024 + 100 * bomb.length;
    await expect(pull(puller())).rejects.toThrow(`expands past ${limit} bytes`);
    assertNoBlobs();
  });

  it('refuses a pull when free space is under minFreeGiB, and checks again while it streams', async () => {
    registry.putImage(IMAGE, buildImage(), 'v1');
    free = 19 * GiB;
    await expect(pull(puller())).rejects.toThrow('under dockerVm.minFreeGiB (20 GiB)');
    expect(registry.requests).toHaveLength(0);

    const image = buildImage({ layers: [tarOf([{ name: 'x', content: Buffer.alloc(200_000, 'q') }])], compression: 'none' });
    registry.putImage(IMAGE, image, 'v2');
    let checks = 0;
    const statfs = async () => {
      checks++;
      return { bavail: checks > 1 ? 1 : 10 ** 9, bsize: 4096 };
    };
    await expect(pull(puller({ statfs, freeSpaceCheckBytes: 64 * 1024 }), { request: { tag: 'v2' } })).rejects.toThrow(
      'dockerVm.minFreeGiB'
    );
    assertNoBlobs();
  });
});

describe('hostile daemon answers', () => {
  it.each(['inspect', 'load', 'tag'] as const)('refuses an oversized %s answer', async (which) => {
    registry.putImage(IMAGE, buildImage(), 'v1');
    daemon.switches.oversize = which;
    await expect(pull(puller())).rejects.toThrow(OVERSIZED);
  });

  it('refuses a load answer naming another image, or a malformed id', async () => {
    registry.putImage(IMAGE, buildImage(), 'v1');
    daemon.switches.loadedId = sha256(Buffer.from('another image'));
    await expect(pull(puller())).rejects.toThrow('loaded');
    daemon.images.clear();
    daemon.switches.loadedId = 'sha256:../../etc';
    await expect(pull(puller())).rejects.toThrow('malformed image id');
  });

  it('refuses an inspect answer whose Id is not the config digest as a hit', async () => {
    const image = buildImage();
    registry.putImage(IMAGE, image, 'v1');
    daemon.switches.inspectId = sha256(Buffer.from('something else'));
    daemon.images.set(image.configDigest, []);
    // Not a hit: the image is loaded, and then the check after the load fails too.
    await expect(pull(puller())).rejects.toThrow();
    expect(daemon.loads).toHaveLength(1);
  });

  it('surfaces a load error in the daemon words, cleaned', async () => {
    registry.putImage(IMAGE, buildImage(), 'v1');
    daemon.switches.loadError = 'no space left on device\x1b[31m';
    await expect(pull(puller())).rejects.toThrow('the Docker VM refused the image: no space left on device');
  });
});

describe('cancelling', () => {
  it('stops the transfers when the signal aborts, and keeps nothing', async () => {
    const image = buildImage({ layers: [tarOf([{ name: 'x', content: Buffer.alloc(100_000, 'y') }])], compression: 'none' });
    registry.putImage(IMAGE, image, 'v1');
    let release: () => void = () => undefined;
    registry.switches.holdBlobs = new Promise<void>((resolve) => (release = resolve));
    const controller = new AbortController();
    const attempt = pull(puller(), { signal: controller.signal });
    for (let i = 0; i < 500 && blobRequests().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(blobRequests().length).toBeGreaterThan(0);
    controller.abort();
    await expect(attempt).rejects.toThrow('cancelled');
    release();
    expect(daemon.loads).toHaveLength(0);
    expect(publicBlobs()).toEqual([]);
  });
});
