/**
 * Runner credentials made for one worker start.
 *
 * A runner registration's RSA key is what GitHub trusts to act as that runner:
 * whoever holds it can open a session under the runner's name - while this app
 * is paused or quit - and be handed the jobs routed to it, secrets included.
 * A worker's sandbox is readable by the job it runs, so the registration key
 * must never be in it.
 *
 * The runner will not start without a key and a token endpoint, but it only
 * ever presents the token to the local broker, which ignores it: every call
 * the broker makes upstream goes out on the registration's own credentials,
 * held app-side under proxies/. So each worker is given a key made for its
 * start, and a token endpoint on its own broker address that knows only that
 * key's public half. Stealing it gets a job nothing it did not already have.
 */

import * as crypto from 'crypto';
import { promisify } from 'util';
import type { CredentialsFile, RSAParamsFile } from './runner-proxy-manager';

const generateKeyPair = promisify(crypto.generateKeyPair);

/** Where, under a worker's broker address, its token endpoint is served. */
export const WORKER_TOKEN_PATH = '/_apis/oauth2/token';

/** What the worker's sandbox gets in place of the registration's files. */
export interface WorkerCredentialFiles {
  credentials: CredentialsFile;
  rsaParams: RSAParamsFile;
}

export interface WorkerCredential {
  clientId: string;
  publicKey: crypto.KeyObject;
  files: WorkerCredentialFiles;
}

/**
 * A fresh key and client id for one worker, as the files the runner reads.
 * The private half exists only in what is returned; nothing here keeps it.
 */
export async function generateWorkerCredential(authorizationUrl: string): Promise<WorkerCredential> {
  // 2048 bits: the runner's JWT library refuses to sign with a smaller key.
  const { publicKey, privateKey } = await generateKeyPair('rsa', { modulusLength: 2048 });
  const clientId = crypto.randomUUID();
  return {
    clientId,
    publicKey,
    files: {
      credentials: {
        scheme: 'OAuth',
        // FIPS on, as config.sh writes it for a real registration: the runner
        // then signs its assertion PS256.
        data: { clientId, authorizationUrl, requireFipsCryptography: 'True' },
      },
      rsaParams: toRsaParams(privateKey.export({ format: 'jwk' })),
    },
  };
}

/**
 * An RSA private key as the runner's .credentials_rsaparams: .NET RSAParameters,
 * each field base64. JWK integers are minimal - a field whose top byte is zero
 * loses it - but .NET wants D as wide as the modulus and the CRT fields half
 * as wide, and refuses the key otherwise, so every field is padded back out.
 */
export function toRsaParams(jwk: crypto.JsonWebKey): RSAParamsFile {
  const bytes = (field: string | undefined) => Buffer.from(field ?? '', 'base64url');
  const fixed = (field: string | undefined, width: number) => {
    const value = bytes(field);
    return (value.length < width ? Buffer.concat([Buffer.alloc(width - value.length), value]) : value).toString('base64');
  };
  const width = bytes(jwk.n).length;
  const half = Math.ceil(width / 2);
  return {
    d: fixed(jwk.d, width),
    dp: fixed(jwk.dp, half),
    dq: fixed(jwk.dq, half),
    exponent: bytes(jwk.e).toString('base64'),
    inverseQ: fixed(jwk.qi, half),
    modulus: fixed(jwk.n, width),
    p: fixed(jwk.p, half),
    q: fixed(jwk.q, half),
  };
}

/** Clock allowance on the assertion's validity window. */
const CLOCK_SKEW_SECONDS = 60;

/**
 * Why a client assertion does not prove possession of this worker's key, or
 * undefined when it does. The runner signs PS256 with FIPS on and RS256 with
 * it off; nothing else is accepted, so a header cannot choose "none" or an
 * HMAC keyed with the public key. The audience is not checked: the key is
 * made for this endpoint and signs nothing else.
 */
export function verifyClientAssertion(
  assertion: string,
  expected: { clientId: string; publicKey: crypto.KeyObject },
  now: number = Date.now()
): string | undefined {
  const parts = assertion.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    return 'not a signed JWT';
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  let header: { alg?: unknown };
  let claims: { iss?: unknown; sub?: unknown; exp?: unknown; nbf?: unknown };
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString());
    claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString());
  } catch {
    return 'not a signed JWT';
  }

  let key: crypto.KeyObject | crypto.VerifyKeyObjectInput;
  if (header?.alg === 'PS256') {
    key = {
      key: expected.publicKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    };
  } else if (header?.alg === 'RS256') {
    key = expected.publicKey;
  } else {
    return `algorithm ${JSON.stringify(header?.alg)} is not accepted`;
  }
  const signed = Buffer.from(`${encodedHeader}.${encodedClaims}`);
  if (!crypto.verify('sha256', signed, key, Buffer.from(encodedSignature, 'base64url'))) {
    return 'signature does not match this worker\'s key';
  }

  if (claims?.iss !== expected.clientId || claims?.sub !== expected.clientId) {
    return 'issued for another client';
  }
  const seconds = now / 1000;
  if (typeof claims.exp !== 'number' || claims.exp < seconds - CLOCK_SKEW_SECONDS) {
    return 'expired';
  }
  if (typeof claims.nbf === 'number' && claims.nbf > seconds + CLOCK_SKEW_SECONDS) {
    return 'not yet valid';
  }
  return undefined;
}
