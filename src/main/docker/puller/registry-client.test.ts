import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as http from 'http';
import { app } from 'electron';
import {
  CredentialsRequiredError,
  PullError,
  RegistryClient,
  RegistryClientOptions,
  parseConfig,
  parseManifest,
  registryOrigin,
  readBody,
} from './registry-client';
import type { RegistryCredentials } from '../registry-auth';
import {
  AUTH_HOST,
  CDN_HOST,
  MEDIA,
  REGISTRY_HOST,
  TestRegistry,
  buildImage,
  buildIndex,
  sha256,
} from './test-registry';

const REPO = 'team/app';
const BAD_DIGESTS = [
  'sha256:../../../../etc/passwd',
  `sha256:${'a'.repeat(63)}`,
  `sha256:${'A'.repeat(64)}`,
  `sha512:${'a'.repeat(128)}`,
  `sha256:${'a'.repeat(64)}/../x`,
];

let registry: TestRegistry;

beforeEach(async () => {
  registry = await TestRegistry.start();
});

afterEach(async () => {
  await registry.close();
});

function client(over: Partial<RegistryClientOptions> = {}): RegistryClient {
  return new RegistryClient({ lookup: registry.lookup, connectTo: registry.connectTo, ca: registry.ca, ...over });
}

const withCredentials = (credentials: RegistryCredentials) => ({ credentials: async () => credentials });

async function blobText(res: http.IncomingMessage): Promise<Buffer> {
  return readBody(res, 1024 * 1024, 'blob');
}

describe('registryOrigin', () => {
  it('maps docker.io to its API host, and keeps every other registry as named', () => {
    expect(registryOrigin('docker.io')).toBe('https://registry-1.docker.io');
    expect(registryOrigin('index.docker.io')).toBe('https://registry-1.docker.io');
    expect(registryOrigin('ghcr.io')).toBe('https://ghcr.io');
    expect(registryOrigin('registry.example.com:5000')).toBe('https://registry.example.com:5000');
  });

  it('refuses anything that is not a bare host, including an http: registry', () => {
    for (const bad of ['http://registry.test', 'https://registry.test', 'user@registry.test', 'registry.test/path', 'registry.test?x', '']) {
      expect(() => registryOrigin(bad)).toThrow(PullError);
    }
  });
});

describe('the token flow', () => {
  it('exchanges the challenge for a bearer token and sends it to the registry', async () => {
    const image = buildImage();
    registry.putImage(REPO, image, 'v1');
    const session = await client().open({ registry: REGISTRY_HOST, repositoryPath: REPO });
    const manifest = await session.manifest('v1');
    expect(manifest.digest).toBe(image.manifestDigest);
    const [token] = registry.requestsTo(AUTH_HOST);
    expect(token.path).toBe(`/token?service=${REGISTRY_HOST}&scope=repository%3A${encodeURIComponent(REPO)}%3Apull`);
    expect(token.headers.authorization).toBeUndefined();
    const api = registry.requestsTo(REGISTRY_HOST, `/v2/${REPO}/manifests/v1`);
    expect(api[api.length - 1].headers.authorization).toMatch(/^Bearer /);
    expect(session.usedCredentials).toBe(false);
  });

  it('sends basic credentials to the token service, and only the token to the registry', async () => {
    registry.users.set('me', 's3cret');
    registry.setPrivate(REPO);
    registry.putImage(REPO, buildImage(), 'v1');
    const session = await client(withCredentials({ kind: 'basic', username: 'me', password: 's3cret' })).open({
      registry: REGISTRY_HOST,
      repositoryPath: REPO,
    });
    await session.manifest('v1');
    // Anonymous first, then, refused, with the credentials.
    const [anonymous, token] = registry.requestsTo(AUTH_HOST);
    expect(anonymous.headers.authorization).toBeUndefined();
    expect(token.headers.authorization).toBe(`Basic ${Buffer.from('me:s3cret').toString('base64')}`);
    for (const request of registry.requestsTo(REGISTRY_HOST)) {
      expect(request.headers.authorization ?? '').not.toMatch(/^Basic /);
    }
    expect(session.usedCredentials).toBe(true);
  });

  it('exchanges an identity token with a POST', async () => {
    registry.refreshTokens.set('refresh-1', 'me');
    registry.setPrivate(REPO);
    registry.putImage(REPO, buildImage(), 'v1');
    const session = await client(withCredentials({ kind: 'identity-token', token: 'refresh-1' })).open({
      registry: REGISTRY_HOST,
      repositoryPath: REPO,
    });
    await expect(session.manifest('v1')).resolves.toBeTruthy();
    const [anonymous, token] = registry.requestsTo(AUTH_HOST);
    expect(anonymous.method).toBe('GET');
    expect(token.method).toBe('POST');
    expect(token.headers.authorization).toBeUndefined();
  });

  it('asks for the credentials only when the registry refuses, and once for the session', async () => {
    const asked: string[] = [];
    const operator = client({
      credentials: async (r) => {
        asked.push(r);
        return { kind: 'basic', username: 'me', password: 'pw' };
      },
    });
    const image = buildImage();
    registry.putImage(REPO, image, 'v1');
    const open = await operator.open({ registry: REGISTRY_HOST, repositoryPath: REPO });
    await open.manifest('v1');
    await blobText(await open.blob(image.configDigest));
    expect(asked).toEqual([]);
    expect(open.usedCredentials).toBe(false);

    registry.users.set('me', 'pw');
    registry.setPrivate(REPO);
    const memo = new Map();
    const closed = await operator.open({ registry: REGISTRY_HOST, repositoryPath: REPO }, 'operator', undefined, memo);
    await closed.manifest('v1');
    await blobText(await closed.blob(image.configDigest));
    expect(asked).toEqual([REGISTRY_HOST]);
    expect(closed.usedCredentials).toBe(true);
    // A second session sharing the memo, as one job's pulls do, asks nothing more.
    const again = await operator.open({ registry: REGISTRY_HOST, repositoryPath: REPO }, 'operator', undefined, memo);
    await again.manifest('v1');
    expect(asked).toEqual([REGISTRY_HOST]);
  });

  it('asks for the credentials when the token service gives no anonymous tokens', async () => {
    registry.users.set('me', 'pw');
    registry.switches.anonymousTokensRefused = true;
    registry.putImage(REPO, buildImage(), 'v1');
    const session = await client(withCredentials({ kind: 'basic', username: 'me', password: 'pw' })).open({
      registry: REGISTRY_HOST,
      repositoryPath: REPO,
    });
    await expect(session.manifest('v1')).resolves.toBeTruthy();
    expect(registry.requestsTo(AUTH_HOST).map((t) => t.headers.authorization)).toEqual([
      undefined,
      `Basic ${Buffer.from('me:pw').toString('base64')}`,
    ]);
    // Without credentials, the refusal is the answer.
    const anonymous = await client().open({ registry: REGISTRY_HOST, repositoryPath: REPO });
    await expect(anonymous.manifest('v1')).rejects.toThrow(`${REGISTRY_HOST}'s token service refused an anonymous token`);
  });

  it('refuses, while credentials are refused, what only they would fetch, and asks for none', async () => {
    let asked = 0;
    registry.users.set('me', 'pw');
    registry.setPrivate(REPO);
    const image = buildImage();
    registry.putImage(REPO, image, 'v1');
    const session = await client({
      credentials: async () => {
        asked++;
        return { kind: 'basic', username: 'me', password: 'pw' };
      },
    }).open({ registry: REGISTRY_HOST, repositoryPath: REPO });
    session.refuseCredentials();
    await expect(session.blob(image.configDigest)).rejects.toBeInstanceOf(CredentialsRequiredError);
    expect(asked).toBe(0);
    session.allowCredentials();
    await expect(blobText(await session.blob(image.configDigest))).resolves.toEqual(image.config);
    expect(asked).toBe(1);
    expect(() => session.refuseCredentials()).toThrow("already sent the operator's credentials");
  });

  it('answers a private repository without credentials as Docker does', async () => {
    registry.setPrivate(REPO);
    registry.putImage(REPO, buildImage(), 'v1');
    const session = await client().open({ registry: REGISTRY_HOST, repositoryPath: REPO });
    await expect(session.manifest('v1')).rejects.toThrow(
      `pull access denied for ${REGISTRY_HOST}/${REPO}, repository does not exist or may require authorization`
    );
  });

  it('sends basic credentials straight to a registry that asks for them, and never to anyone else', async () => {
    registry.switches.basicChallenge = true;
    registry.switches.redirectBlobsTo = `https://${CDN_HOST}/blobs/`;
    registry.users.set('me', 'pw');
    const image = buildImage();
    registry.putImage(REPO, image, 'v1');
    const session = await client(withCredentials({ kind: 'basic', username: 'me', password: 'pw' })).open({
      registry: REGISTRY_HOST,
      repositoryPath: REPO,
    });
    await session.manifest('v1');
    await blobText(await session.blob(image.configDigest));
    expect(registry.requestsTo(CDN_HOST)[0].headers.authorization).toBeUndefined();
  });
});

describe('where credentials go', () => {
  beforeEach(() => {
    registry.users.set('me', 'pw');
  });

  const operator = () => client(withCredentials({ kind: 'basic', username: 'me', password: 'pw' }));

  async function fetchBlobThroughRedirect(target: string): Promise<Buffer> {
    registry.switches.redirectBlobsTo = target;
    const image = buildImage();
    registry.putImage(REPO, image, 'v1');
    const session = await operator().open({ registry: REGISTRY_HOST, repositoryPath: REPO });
    return blobText(await session.blob(image.configDigest));
  }

  it('sends no Authorization and no cookie on a redirect to another host', async () => {
    const bytes = await fetchBlobThroughRedirect(`https://${CDN_HOST}/blobs/`);
    expect(bytes.length).toBeGreaterThan(0);
    const [hop] = registry.requestsTo(CDN_HOST);
    expect(hop.headers.authorization).toBeUndefined();
    expect(hop.headers.cookie).toBeUndefined();
  });

  it('sends no Authorization on a redirect back to the registry origin either', async () => {
    await fetchBlobThroughRedirect(`https://${REGISTRY_HOST}/cdn/`);
    const [hop] = registry.requestsTo(REGISTRY_HOST, '/cdn/');
    expect(hop.headers.authorization).toBeUndefined();
    expect(hop.headers.cookie).toBeUndefined();
  });

  it('follows up to five redirects, each without credentials, and refuses a sixth', async () => {
    registry.switches.cdnHops = 4;
    await fetchBlobThroughRedirect(`https://${CDN_HOST}/blobs/`);
    expect(registry.requestsTo(CDN_HOST)).toHaveLength(5);
    for (const hop of registry.requestsTo(CDN_HOST)) expect(hop.headers.authorization).toBeUndefined();

    registry.switches.cdnHops = 5;
    await expect(fetchBlobThroughRedirect(`https://${CDN_HOST}/blobs/`)).rejects.toThrow('more than 5 redirects');
  });

  it('refuses a redirect to plain http', async () => {
    await expect(fetchBlobThroughRedirect(`http://${CDN_HOST}/blobs/`)).rejects.toThrow(
      `redirected to http://${CDN_HOST}/blobs/`
    );
    expect(registry.requestsTo(CDN_HOST)).toHaveLength(0);
  });

  it('screens a redirect target, and refuses one on the LAN or loopback', async () => {
    await expect(fetchBlobThroughRedirect('https://lan.test/blobs/')).rejects.toThrow(
      '`lan.test` (where the registry redirected) resolves to a private address (10.0.0.5); localmost pulls only from public https registries'
    );
    await expect(fetchBlobThroughRedirect('https://loop.test/blobs/')).rejects.toThrow('(127.0.0.1)');
  });

  it.each([
    ['an http: realm', `http://${AUTH_HOST}/token`],
    ['a realm on loopback', 'https://loop.test/token'],
    ['a realm on 10.x', 'https://lan.test/token'],
    ['a realm on a link-local address', 'https://linklocal.test/token'],
  ])('refuses %s without sending the credentials', async (_what, realm) => {
    registry.switches.realm = realm;
    registry.putImage(REPO, buildImage(), 'v1');
    const session = await operator().open({ registry: REGISTRY_HOST, repositoryPath: REPO });
    await expect(session.manifest('v1')).rejects.toThrow(`the registry's token service ${realm} is not a public https URL`);
    expect(registry.requestsTo(AUTH_HOST)).toHaveLength(0);
  });

  it.each([
    ['a Bearer challenge naming another realm', 'Bearer realm="https://other.test/steal",service="cdn.test"'],
    ['a Basic challenge', 'Basic realm="cdn.test"'],
  ])('never answers %s from a redirect target, and sends the credentials nowhere', async (_what, challenge) => {
    // The registry redirects the session's very first request, so no token
    // has been asked for yet; the CDN then asks for credentials itself.
    registry.switches.openBlobs = true;
    registry.switches.cdnChallenge = challenge;
    registry.switches.redirectBlobsTo = `https://${CDN_HOST}/blobs/`;
    const image = buildImage();
    registry.putImage(REPO, image, 'v1');
    const session = await operator().open({ registry: REGISTRY_HOST, repositoryPath: REPO });
    await expect(session.blob(image.configDigest)).rejects.toThrow(
      `\`${CDN_HOST}\` (where the registry redirected) answered 401; localmost answers only the registry's own challenge`
    );
    expect(registry.requestsTo('other.test')).toHaveLength(0);
    expect(registry.requestsTo(AUTH_HOST)).toHaveLength(0);
    for (const request of registry.requests) expect(request.headers.authorization).toBeUndefined();
    expect(session.usedCredentials).toBe(false);
  });

  it('refuses a token service that redirects, and sends the credentials nowhere else', async () => {
    registry.switches.tokenRedirect = `https://${CDN_HOST}/steal`;
    registry.putImage(REPO, buildImage(), 'v1');
    const session = await operator().open({ registry: REGISTRY_HOST, repositoryPath: REPO });
    await expect(session.manifest('v1')).rejects.toThrow('redirected the token request');
    expect(registry.requestsTo(CDN_HOST)).toHaveLength(0);
  });
});

describe('an expired token', () => {
  it('is renewed once, with the challenge the registry sends, and the request retried', async () => {
    registry.users.set('me', 'pw');
    registry.setPrivate(REPO);
    registry.switches.tokenMaxUses = 1;
    const image = buildImage();
    registry.putImage(REPO, image, 'v1');
    const session = await client(withCredentials({ kind: 'basic', username: 'me', password: 'pw' })).open({
      registry: REGISTRY_HOST,
      repositoryPath: REPO,
    });
    await session.manifest('v1');
    await expect(blobText(await session.blob(image.configDigest))).resolves.toEqual(image.config);
    // An anonymous token, refused; one with the credentials; and its renewal, with them too.
    const tokens = registry.requestsTo(AUTH_HOST).map((t) => t.headers.authorization);
    const basic = `Basic ${Buffer.from('me:pw').toString('base64')}`;
    expect(tokens).toEqual([undefined, basic, basic]);
  });

  it('is renewed at most once for one request: a second 401 is the answer', async () => {
    registry.putImage(REPO, buildImage(), 'v1');
    const session = await client().open({ registry: REGISTRY_HOST, repositoryPath: REPO });
    await session.manifest('v1');
    expect(registry.requestsTo(AUTH_HOST)).toHaveLength(1);
    expect(registry.requestsTo(REGISTRY_HOST)).toHaveLength(2);
    // Every token has now expired, the new one too.
    registry.switches.tokenMaxUses = 0;
    await expect(session.manifest('v1')).rejects.toThrow(`pull access denied for ${REGISTRY_HOST}/${REPO}`);
    expect(registry.requestsTo(AUTH_HOST)).toHaveLength(2);
    expect(registry.requestsTo(REGISTRY_HOST)).toHaveLength(4);
  });
});

describe('request()', () => {
  it('sends an authorization only to the origin it names', async () => {
    const c = client();
    const target = new URL(`https://${CDN_HOST}/blobs/x`);
    const { res, hops } = await c.request(
      target,
      { method: 'GET', authorization: { origin: `https://${REGISTRY_HOST}`, value: 'Bearer for-the-registry' }, redirects: 'follow' },
      () => 'the CDN'
    );
    res.resume();
    expect(hops).toBe(0);
    expect(registry.requestsTo(CDN_HOST)[0].headers.authorization).toBeUndefined();
  });
});

describe('the test-only options', () => {
  afterEach(() => {
    (app as { isPackaged: boolean }).isPackaged = false;
  });

  it('are refused in a packaged app', () => {
    (app as { isPackaged: boolean }).isPackaged = true;
    expect(() => new RegistryClient({ connectTo: registry.connectTo })).toThrow('test-only');
    expect(() => new RegistryClient({ ca: registry.ca })).toThrow('test-only');
    expect(() => new RegistryClient({ lookup: registry.lookup })).not.toThrow();
  });
});

describe('screening the registry itself', () => {
  it.each([
    ['loop.test', '127.0.0.1'],
    ['lan.test', '10.0.0.5'],
  ])('refuses a registry named %s, which resolves to %s', async (host, address) => {
    const session = await client().open({ registry: host, repositoryPath: REPO });
    await expect(session.manifest('v1')).rejects.toThrow(
      `registry \`${host}\` resolves to a private address (${address}); localmost pulls only from public https registries`
    );
    expect(registry.requests).toHaveLength(0);
  });

  it('refuses a name that does not resolve', async () => {
    const session = await client().open({ registry: 'nowhere.test', repositoryPath: REPO });
    await expect(session.manifest('v1')).rejects.toThrow('could not be resolved');
  });
});

describe('manifests', () => {
  it('identifies a manifest by the hash of its bytes, not by Docker-Content-Digest', async () => {
    const image = buildImage();
    registry.putImage(REPO, image, 'v1');
    registry.switches.contentDigestHeader = sha256(Buffer.from('something else'));
    const session = await client().open({ registry: REGISTRY_HOST, repositoryPath: REPO });
    const manifest = await session.manifest('v1');
    expect(manifest.digest).toBe(image.manifestDigest);
    expect(manifest.headerDigest).toBe(sha256(Buffer.from('something else')));
  });

  it('refuses a malformed Docker-Content-Digest on a HEAD', async () => {
    registry.putImage(REPO, buildImage(), 'v1');
    for (const bad of BAD_DIGESTS) {
      registry.switches.contentDigestHeader = bad;
      const session = await client().open({ registry: REGISTRY_HOST, repositoryPath: REPO });
      await expect(session.head('v1')).rejects.toThrow(`the registry sent a malformed digest for ${REGISTRY_HOST}/${REPO}:v1`);
    }
  });

  it('answers a HEAD with the validated digest, or null when the registry has no such manifest', async () => {
    const image = buildImage();
    registry.putImage(REPO, image, 'v1');
    const session = await client().open({ registry: REGISTRY_HOST, repositoryPath: REPO });
    await expect(session.head('v1')).resolves.toEqual({ digest: image.manifestDigest });
    await expect(session.head('v2')).resolves.toBeNull();
  });

  it('refuses a reference that is neither a tag nor a valid digest before any request', async () => {
    const session = await client().open({ registry: REGISTRY_HOST, repositoryPath: REPO });
    for (const bad of [...BAD_DIGESTS, '../x', 'a/b', '']) {
      await expect(session.manifest(bad)).rejects.toThrow(PullError);
      await expect(session.blob(bad)).rejects.toThrow(PullError);
    }
    expect(registry.requests).toHaveLength(0);
  });

  it("surfaces a 429 in Docker Hub's own words", async () => {
    registry.putImage(REPO, buildImage(), 'v1');
    registry.switches.rateLimited = true;
    const session = await client().open({ registry: REGISTRY_HOST, repositoryPath: REPO });
    await expect(session.manifest('v1')).rejects.toThrow(
      'toomanyrequests: You have reached your unauthenticated pull rate limit. https://www.docker.com/increase-rate-limit'
    );
  });

  it('says which manifest was not found', async () => {
    registry.putImage(REPO, buildImage(), 'v1');
    const session = await client().open({ registry: REGISTRY_HOST, repositoryPath: REPO });
    await expect(session.manifest('nope')).rejects.toThrow(`manifest for ${REGISTRY_HOST}/${REPO}:nope not found: manifest unknown`);
  });
});

describe('parseManifest', () => {
  const ref = 'registry.test/team/app:v1';
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));

  it('reads a single-platform manifest and an index', () => {
    const image = buildImage();
    const parsed = parseManifest(image.manifest, MEDIA.ociManifest, ref);
    expect(parsed).toEqual({
      kind: 'manifest',
      mediaType: MEDIA.ociManifest,
      config: { mediaType: MEDIA.ociConfig, digest: image.configDigest, size: image.config.length },
      layers: [expect.objectContaining({ digest: [...image.blobs.keys()][0] })],
    });
    const index = buildIndex([{ image, platform: { architecture: 'arm64', os: 'linux', variant: 'v8' } }]);
    expect(parseManifest(index.bytes, MEDIA.ociIndex, ref)).toEqual({
      kind: 'index',
      mediaType: MEDIA.ociIndex,
      manifests: [
        {
          mediaType: MEDIA.ociManifest,
          digest: image.manifestDigest,
          size: image.manifest.length,
          platform: { architecture: 'arm64', os: 'linux', variant: 'v8' },
        },
      ],
    });
  });

  it('reads Docker schema 2 manifests and manifest lists', () => {
    const image = buildImage({ docker: true });
    expect(parseManifest(image.manifest, MEDIA.dockerManifest, ref).kind).toBe('manifest');
    const list = buildIndex([{ image, platform: { architecture: 'arm64', os: 'linux' } }], { docker: true });
    expect(parseManifest(list.bytes, MEDIA.dockerList, ref).kind).toBe('index');
  });

  it('refuses schema 1', () => {
    const schema1 = json({ schemaVersion: 1, name: 'team/app', tag: 'v1', fsLayers: [], history: [] });
    expect(() => parseManifest(schema1, MEDIA.schema1, ref)).toThrow('schema 1');
    expect(() => parseManifest(schema1, 'application/json', ref)).toThrow('schema 1');
  });

  it.each([
    ['a descriptor with urls', (m: { layers: Array<Record<string, unknown>> }) => { m.layers[0].urls = ['https://cdn.example/x']; }],
    ['a foreign layer', (m: { layers: Array<Record<string, unknown>> }) => { m.layers[0].mediaType = MEDIA.dockerForeign; }],
    ['a non-distributable layer', (m: { layers: Array<Record<string, unknown>> }) => { m.layers[0].mediaType = MEDIA.ociNondistributable; }],
    [
      'a non-distributable layer of another compression',
      (m: { layers: Array<Record<string, unknown>> }) => { m.layers[0].mediaType = 'application/vnd.oci.image.layer.nondistributable.v1.tar'; },
    ],
  ])('refuses %s', (_what, edit) => {
    const image = buildImage({ editManifest: edit as never });
    const layer = JSON.parse(image.manifest.toString()).layers[0].digest;
    expect(() => parseManifest(image.manifest, MEDIA.ociManifest, ref)).toThrow(
      `image layer ${layer} must be fetched from a URL the image names, which localmost does not do`
    );
  });

  it('refuses a layer or config media type it does not know', () => {
    const odd = buildImage({ editManifest: (m) => { m.layers[0].mediaType = 'application/x-something'; } });
    expect(() => parseManifest(odd.manifest, MEDIA.ociManifest, ref)).toThrow('application/x-something');
    const oddConfig = buildImage({ editManifest: (m) => { m.config.mediaType = 'application/vnd.cncf.helm.config.v1+json'; } });
    expect(() => parseManifest(oddConfig.manifest, MEDIA.ociManifest, ref)).toThrow('application/vnd.cncf.helm.config.v1+json');
  });

  it.each(BAD_DIGESTS)('refuses the malformed digest %s as a layer, config or index entry', (bad) => {
    const layer = buildImage({ editManifest: (m) => { m.layers[0].digest = bad; } });
    expect(() => parseManifest(layer.manifest, MEDIA.ociManifest, ref)).toThrow(`the registry sent a malformed digest for ${ref}`);
    const config = buildImage({ editManifest: (m) => { m.config.digest = bad; } });
    expect(() => parseManifest(config.manifest, MEDIA.ociManifest, ref)).toThrow(`the registry sent a malformed digest for ${ref}`);
    const index = buildIndex([{ image: buildImage(), platform: { architecture: 'arm64', os: 'linux' } }], {
      edit: (i) => { i.manifests[0].digest = bad; },
    });
    expect(() => parseManifest(index.bytes, MEDIA.ociIndex, ref)).toThrow(`the registry sent a malformed digest for ${ref}`);
  });

  it('refuses sizes that are not byte counts', () => {
    for (const size of [-1, 1.5, '12', Number.MAX_SAFE_INTEGER + 2]) {
      const image = buildImage({ editManifest: (m) => { (m.layers[0] as unknown as Record<string, unknown>).size = size; } });
      expect(() => parseManifest(image.manifest, MEDIA.ociManifest, ref)).toThrow(PullError);
    }
  });

  it('refuses what is not a manifest at all', () => {
    expect(() => parseManifest(Buffer.from('not json'), MEDIA.ociManifest, ref)).toThrow(PullError);
    expect(() => parseManifest(json([1, 2]), MEDIA.ociManifest, ref)).toThrow(PullError);
    expect(() => parseManifest(json({ schemaVersion: 2, mediaType: 'text/html' }), 'text/html', ref)).toThrow(PullError);
  });
});

describe('parseConfig', () => {
  const ref = 'registry.test/team/app:v1';

  it('reads the platform and the diff_ids', () => {
    const image = buildImage({ architecture: 'amd64' });
    expect(parseConfig(image.config, 1, ref)).toEqual({ architecture: 'amd64', os: 'linux', variant: undefined, diffIds: image.diffIds });
  });

  it.each(BAD_DIGESTS)('refuses the malformed diff_id %s', (bad) => {
    const image = buildImage({ editConfig: (c) => { (c.rootfs as { diff_ids: string[] }).diff_ids[0] = bad; } });
    expect(() => parseConfig(image.config, 1, ref)).toThrow(`the registry sent a malformed digest for ${ref}`);
  });

  it('refuses diff_ids that do not match the layers one for one', () => {
    const image = buildImage();
    expect(() => parseConfig(image.config, 2, ref)).toThrow('1 diff_ids for 2 layers');
  });
});
