import { describe, it, expect, beforeAll } from '@jest/globals';
import * as crypto from 'crypto';
import {
  generateWorkerCredential,
  toRsaParams,
  verifyClientAssertion,
  type WorkerCredential,
} from './worker-credentials';

const AUTH_URL = `http://127.0.0.1:8787/w/${'a'.repeat(64)}/_apis/oauth2/token`;

/** Rebuild the private key the way the runner does: from the file's fields. */
const privateKeyFromParams = (p: WorkerCredential['files']['rsaParams']): crypto.KeyObject =>
  crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'RSA',
      n: Buffer.from(p.modulus, 'base64').toString('base64url'),
      e: Buffer.from(p.exponent, 'base64').toString('base64url'),
      d: Buffer.from(p.d, 'base64').toString('base64url'),
      p: Buffer.from(p.p, 'base64').toString('base64url'),
      q: Buffer.from(p.q, 'base64').toString('base64url'),
      dp: Buffer.from(p.dp, 'base64').toString('base64url'),
      dq: Buffer.from(p.dq, 'base64').toString('base64url'),
      qi: Buffer.from(p.inverseQ, 'base64').toString('base64url'),
    },
  });

/** A client assertion shaped like the one Runner.Listener 2.336 sends (seen on the wire). */
const assertion = (
  key: crypto.KeyObject,
  claims: Record<string, unknown>,
  alg: 'PS256' | 'RS256' = 'PS256'
): string => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${b64({ typ: 'JWT', alg })}.${b64(claims)}`;
  const signature = alg === 'PS256'
    ? crypto.sign('sha256', Buffer.from(input), {
      key,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    : crypto.sign('sha256', Buffer.from(input), key);
  return `${input}.${signature.toString('base64url')}`;
};

describe('generateWorkerCredential', () => {
  let credential: WorkerCredential;
  beforeAll(async () => {
    credential = await generateWorkerCredential(AUTH_URL);
  });

  it('writes a credentials file that points the runner at the given token endpoint', () => {
    expect(credential.files.credentials).toEqual({
      scheme: 'OAuth',
      data: {
        clientId: credential.clientId,
        authorizationUrl: AUTH_URL,
        requireFipsCryptography: 'True',
      },
    });
    expect(credential.clientId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('writes RSA parameters .NET will import: fixed-width fields for a 2048-bit key', () => {
    // RSA.ImportParameters refuses a D shorter than the modulus, or a P, Q,
    // DP, DQ or InverseQ shorter than half of it.
    const len = (b64: string) => Buffer.from(b64, 'base64').length;
    const p = credential.files.rsaParams;
    expect(len(p.modulus)).toBe(256);
    expect(len(p.d)).toBe(256);
    for (const half of [p.p, p.q, p.dp, p.dq, p.inverseQ]) expect(len(half)).toBe(128);
    expect(Buffer.from(p.exponent, 'base64').toString('hex')).toBe('010001');
  });

  it('writes the private half of the public key it hands back', () => {
    const rebuilt = privateKeyFromParams(credential.files.rsaParams);
    const signature = crypto.sign('sha256', Buffer.from('x'), rebuilt);
    expect(crypto.verify('sha256', Buffer.from('x'), credential.publicKey, signature)).toBe(true);
  });

  it('makes a different key and client id for every worker', async () => {
    const other = await generateWorkerCredential(AUTH_URL);
    expect(other.clientId).not.toBe(credential.clientId);
    expect(other.files.rsaParams.modulus).not.toBe(credential.files.rsaParams.modulus);
  });
});

describe('toRsaParams', () => {
  it('left-pads a field whose leading zero byte the JWK encoding dropped', () => {
    // About one key in 128 has such a field. JWK integers are minimal, .NET's
    // are fixed-width, and the runner cannot load a key with a short field.
    const full = (n: number, fill: number) => Buffer.alloc(n, fill).toString('base64url');
    const shortD = Buffer.alloc(255, 7).toString('base64url');
    const shortP = Buffer.alloc(127, 9).toString('base64url');
    const params = toRsaParams({
      kty: 'RSA',
      n: full(256, 0xff),
      e: 'AQAB',
      d: shortD,
      p: shortP,
      q: full(128, 1),
      dp: full(128, 2),
      dq: full(128, 3),
      qi: full(128, 4),
    });
    const d = Buffer.from(params.d, 'base64');
    const p = Buffer.from(params.p, 'base64');
    expect(d.length).toBe(256);
    expect(d[0]).toBe(0);
    expect(d.subarray(1).equals(Buffer.alloc(255, 7))).toBe(true);
    expect(p.length).toBe(128);
    expect(p[0]).toBe(0);
  });
});

describe('verifyClientAssertion', () => {
  let credential: WorkerCredential;
  let privateKey: crypto.KeyObject;
  const now = 1_790_000_000;
  const claims = (overrides: Record<string, unknown> = {}) => ({
    sub: credential.clientId,
    jti: crypto.randomUUID(),
    iss: credential.clientId,
    aud: AUTH_URL,
    nbf: now - 1,
    exp: now + 299,
    ...overrides,
  });

  beforeAll(async () => {
    credential = await generateWorkerCredential(AUTH_URL);
    privateKey = privateKeyFromParams(credential.files.rsaParams);
  });

  it('accepts the PS256 assertion the runner signs with its key file', () => {
    expect(verifyClientAssertion(assertion(privateKey, claims()), credential, now * 1000)).toBeUndefined();
  });

  it('accepts RS256, which the runner signs with when FIPS is off', () => {
    expect(verifyClientAssertion(assertion(privateKey, claims(), 'RS256'), credential, now * 1000)).toBeUndefined();
  });

  it('refuses an assertion signed by any other key', async () => {
    // The registration's own key, or another worker's, is not this worker.
    const other = await generateWorkerCredential(AUTH_URL);
    const signed = assertion(privateKeyFromParams(other.files.rsaParams), claims());
    expect(verifyClientAssertion(signed, credential, now * 1000)).toMatch(/signature/);
  });

  it('refuses a token whose header names an algorithm outside the allowlist', () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ typ: 'JWT', alg: 'none' })}.${b64(claims())}.`;
    expect(verifyClientAssertion(unsigned, credential, now * 1000)).toBeDefined();
    const noneWithSignature = `${b64({ typ: 'JWT', alg: 'none' })}.${b64(claims())}.${Buffer.from('x').toString('base64url')}`;
    expect(verifyClientAssertion(noneWithSignature, credential, now * 1000)).toMatch(/algorithm/);
    const hmac = `${b64({ typ: 'JWT', alg: 'HS256' })}.${b64(claims())}.${Buffer.from('x').toString('base64url')}`;
    expect(verifyClientAssertion(hmac, credential, now * 1000)).toMatch(/algorithm/);
  });

  it('refuses an expired assertion, and one not yet valid', () => {
    expect(verifyClientAssertion(assertion(privateKey, claims({ exp: now - 120 })), credential, now * 1000)).toMatch(/expired/);
    expect(verifyClientAssertion(assertion(privateKey, claims({ nbf: now + 600 })), credential, now * 1000)).toMatch(/not yet valid/);
    expect(verifyClientAssertion(assertion(privateKey, claims({ exp: undefined })), credential, now * 1000)).toMatch(/expired/);
  });

  it('refuses an assertion issued for another client id', () => {
    expect(verifyClientAssertion(assertion(privateKey, claims({ iss: 'someone-else' })), credential, now * 1000)).toMatch(/client/);
    expect(verifyClientAssertion(assertion(privateKey, claims({ sub: 'someone-else' })), credential, now * 1000)).toMatch(/client/);
  });

  it('refuses anything that is not a three-part token', () => {
    expect(verifyClientAssertion('', credential, now * 1000)).toBeDefined();
    expect(verifyClientAssertion('a.b', credential, now * 1000)).toBeDefined();
    expect(verifyClientAssertion('%%%.%%%.%%%', credential, now * 1000)).toBeDefined();
  });
});
