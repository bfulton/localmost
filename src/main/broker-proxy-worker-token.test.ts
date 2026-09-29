import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';

jest.mock('./app-state', () => ({
  getLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
}));

import { BrokerProxyService } from './broker-proxy-service';
import type { WorkerCredentialFiles } from './worker-credentials';

/**
 * The token endpoint a worker's runner authenticates against. The runner is
 * given a key made for its start instead of the registration's, and gets its
 * token from its own broker address.
 */
describe('BrokerProxyService worker token endpoint', () => {
  interface Internals {
    handleRequest(req: unknown, res: unknown): Promise<void>;
  }

  const fakeRequest = (method: string, url: string, body = '') => {
    const req = new EventEmitter() as EventEmitter & {
      method: string; url: string; headers: Record<string, string>;
      [Symbol.asyncIterator]: () => AsyncGenerator<Buffer>;
    };
    req.method = method;
    req.url = url;
    req.headers = {};
    req[Symbol.asyncIterator] = async function* () { if (body) yield Buffer.from(body); };
    (req as unknown as { resume: () => void }).resume = () => {};
    return req;
  };

  const fakeResponse = () => {
    const res = { statusCode: 0, body: '' } as {
      statusCode: number; body: string;
      writeHead: (code: number) => unknown; end: (chunk?: unknown) => unknown;
    };
    res.writeHead = (code) => { res.statusCode = code; return res; };
    res.end = (chunk) => { res.body = chunk ? String(chunk) : ''; return res; };
    return res;
  };

  /** The private key the runner would rebuild from its key file. */
  const runnerKey = (files: WorkerCredentialFiles) => {
    const b = (v: string) => Buffer.from(v, 'base64').toString('base64url');
    const p = files.rsaParams;
    return crypto.createPrivateKey({
      format: 'jwk',
      key: { kty: 'RSA', n: b(p.modulus), e: b(p.exponent), d: b(p.d), p: b(p.p), q: b(p.q), dp: b(p.dp), dq: b(p.dq), qi: b(p.inverseQ) },
    });
  };

  /** The client assertion Runner.Listener sends: PS256, iss = sub = clientId, 5 minutes. */
  const clientAssertion = (files: WorkerCredentialFiles, signWith = runnerKey(files)) => {
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const { clientId, authorizationUrl } = files.credentials.data;
    const input = `${b64({ typ: 'JWT', alg: 'PS256' })}.${b64({ sub: clientId, jti: crypto.randomUUID(), iss: clientId, aud: authorizationUrl, nbf: now, exp: now + 300 })}`;
    const signature = crypto.sign('sha256', Buffer.from(input), {
      key: signWith,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
    return `${input}.${signature.toString('base64url')}`;
  };

  const tokenForm = (assertion: string, grant = 'client_credentials') => new URLSearchParams({
    grant_type: grant,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
  }).toString();

  let service: BrokerProxyService;
  const post = async (url: string, body: string) => {
    const res = fakeResponse();
    await (service as unknown as Internals).handleRequest(fakeRequest('POST', new URL(url).pathname, body), res);
    return res;
  };

  beforeEach(() => {
    service = new BrokerProxyService(8787);
  });

  it("points the worker's credentials at a token path under its own broker address", async () => {
    const brokerUrl = service.issueWorkerKey(1, 'target-a');
    const files = await service.issueWorkerCredential(1);

    expect(files!.credentials.scheme).toBe('OAuth');
    expect(files!.credentials.data.authorizationUrl).toBe(`${brokerUrl}_apis/oauth2/token`);
  });

  it('issues a token for an assertion signed with the key made for this worker', async () => {
    service.issueWorkerKey(1, 'target-a');
    const files = (await service.issueWorkerCredential(1))!;

    const res = await post(files.credentials.data.authorizationUrl, tokenForm(clientAssertion(files)));

    expect(res.statusCode).toBe(200);
    const token = JSON.parse(res.body);
    expect(typeof token.access_token).toBe('string');
    expect(token.access_token.length).toBeGreaterThanOrEqual(32);
    expect(token.token_type).toBe('bearer');
    expect(token.expires_in).toBeGreaterThan(0);
  });

  it("refuses another worker's assertion, even presented on this worker's address", async () => {
    // Worker 2's job holds worker 2's key file. It must not get a token as
    // worker 1, which is the only thing a stolen key could be for here.
    service.issueWorkerKey(1, 'target-a');
    service.issueWorkerKey(2, 'target-a');
    const one = (await service.issueWorkerCredential(1))!;
    const two = (await service.issueWorkerCredential(2))!;

    const res = await post(one.credentials.data.authorizationUrl, tokenForm(clientAssertion(two)));

    expect(res.statusCode).toBe(401);
    // Never invalid_client: the runner reads that as "the registration was
    // deleted" and the manager then re-registers the target with GitHub.
    expect(JSON.parse(res.body).error).toBe('unauthorized_client');
  });

  it('refuses an assertion signed by a key other than the worker was given', async () => {
    service.issueWorkerKey(1, 'target-a');
    const files = (await service.issueWorkerCredential(1))!;
    const { privateKey: registrationKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

    const res = await post(files.credentials.data.authorizationUrl, tokenForm(clientAssertion(files, registrationKey)));

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).not.toBe('invalid_client');
  });

  it("stops honouring a start's key once the slot is started again", async () => {
    const first = service.issueWorkerKey(1, 'target-a');
    const old = (await service.issueWorkerCredential(1))!;
    const second = service.issueWorkerKey(1, 'target-a');
    const current = (await service.issueWorkerCredential(1))!;

    // The old address is refused outright; the old key does not work at the new one.
    expect((await post(`${first}_apis/oauth2/token`, tokenForm(clientAssertion(old)))).statusCode).toBe(403);
    expect((await post(`${second}_apis/oauth2/token`, tokenForm(clientAssertion(old)))).statusCode).toBe(401);
    expect((await post(`${second}_apis/oauth2/token`, tokenForm(clientAssertion(current)))).statusCode).toBe(200);
  });

  it('refuses a worker that was never given a credential', async () => {
    // A live key alone is not enough: the worker must hold the key made for it.
    const brokerUrl = service.issueWorkerKey(1, 'target-a');
    const other = new BrokerProxyService(8787);
    other.issueWorkerKey(1);
    const elsewhere = (await other.issueWorkerCredential(1))!;

    const res = await post(`${brokerUrl}_apis/oauth2/token`, tokenForm(clientAssertion(elsewhere)));

    expect(res.statusCode).toBe(401);
  });

  it('refuses a grant other than client credentials with a JWT assertion', async () => {
    service.issueWorkerKey(1, 'target-a');
    const files = (await service.issueWorkerCredential(1))!;

    const res = await post(files.credentials.data.authorizationUrl, tokenForm(clientAssertion(files), 'password'));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('unsupported_grant_type');
  });

  it('is not served without a worker key', async () => {
    const res = await post('http://127.0.0.1:8787/_apis/oauth2/token', tokenForm('x.y.z'));
    expect(res.statusCode).toBe(403);
  });

  it('refuses, rather than failing, a request whose worker is stopped while it is being read', async () => {
    service.issueWorkerKey(1, 'target-a');
    const files = (await service.issueWorkerCredential(1))!;
    let release!: () => void;
    const bodyArrives = new Promise<void>((resolve) => { release = resolve; });
    const req = fakeRequest('POST', new URL(files.credentials.data.authorizationUrl).pathname);
    const body = tokenForm(clientAssertion(files));
    req[Symbol.asyncIterator] = async function* () { await bodyArrives; yield Buffer.from(body); };
    const res = fakeResponse();

    const handled = (service as unknown as Internals).handleRequest(req, res);
    service.revokeWorkerKey(1);
    release();
    await handled;

    expect(res.statusCode).toBe(403);
  });

  it('has nothing to issue for a slot with no live key', async () => {
    expect(await service.issueWorkerCredential(3)).toBeUndefined();
  });

  it('issues nothing when the slot is started again while the key is being made', async () => {
    // Key generation is asynchronous; a credential for a key already revoked
    // would point the worker at an address that refuses it.
    service.issueWorkerKey(1, 'target-a');
    const pending = service.issueWorkerCredential(1);
    service.revokeWorkerKey(1);
    expect(await pending).toBeUndefined();
  });
});
