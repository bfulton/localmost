/**
 * OAuth Token Manager
 *
 * Handles OAuth token generation and caching for runner instances.
 * Uses JWT client credentials flow to authenticate with GitHub.
 */

import * as crypto from 'crypto';
import * as https from 'https';
import { getLogger } from '../app-state';

const log = () => getLogger();

/** RSA parameters from .credentials_rsaparams file */
export interface RSAParams {
  d: string;
  dp: string;
  dq: string;
  exponent: string;
  inverseQ: string;
  modulus: string;
  p: string;
  q: string;
}

/** Credentials from .credentials file */
export interface Credentials {
  scheme: string;
  data: {
    clientId: string;
    authorizationUrl: string;
    requireFipsCryptography: string;
  };
}

/** Cached token state */
interface TokenCache {
  accessToken: string;
  expiry: number;
}

/**
 * Build a private key from RSA parameters.
 */
function buildPrivateKey(rsaParams: RSAParams): crypto.KeyObject {
  const jwk = {
    kty: 'RSA',
    n: Buffer.from(rsaParams.modulus, 'base64').toString('base64url'),
    e: Buffer.from(rsaParams.exponent, 'base64').toString('base64url'),
    d: Buffer.from(rsaParams.d, 'base64').toString('base64url'),
    p: Buffer.from(rsaParams.p, 'base64').toString('base64url'),
    q: Buffer.from(rsaParams.q, 'base64').toString('base64url'),
    dp: Buffer.from(rsaParams.dp, 'base64').toString('base64url'),
    dq: Buffer.from(rsaParams.dq, 'base64').toString('base64url'),
    qi: Buffer.from(rsaParams.inverseQ, 'base64').toString('base64url'),
  };
  return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
}

/**
 * Create a JWT for OAuth client credentials flow.
 */
function createJWT(clientId: string, authorizationUrl: string, privateKey: crypto.KeyObject): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    sub: clientId,
    iss: clientId,
    aud: authorizationUrl,
    iat: now,
    exp: now + 60,
    nbf: now,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), privateKey);

  return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * Make an HTTPS request.
 */
function httpsRequest(
  url: string,
  options: https.RequestOptions,
  body?: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      ...options,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Manages OAuth tokens for runner instances.
 * Caches tokens and handles refresh when expired.
 */
export class OAuthTokenManager {
  private tokenCache: Map<string, TokenCache> = new Map();

  /** Buffer time before expiry to refresh token (ms) */
  private static readonly EXPIRY_BUFFER_MS = 60000;

  /**
   * Generate a cache key for a target/instance combination.
   */
  private getCacheKey(targetId: string, instanceNum: number): string {
    return `${targetId}:${instanceNum}`;
  }

  /**
   * Get an OAuth token for a runner instance.
   * Returns cached token if still valid, otherwise fetches a new one.
   */
  async getToken(
    targetId: string,
    instanceNum: number,
    credentials: Credentials,
    rsaParams: RSAParams,
    targetDisplayName: string
  ): Promise<string> {
    const cacheKey = this.getCacheKey(targetId, instanceNum);
    const cached = this.tokenCache.get(cacheKey);

    // Check if we have a valid cached token
    if (cached && Date.now() < cached.expiry - OAuthTokenManager.EXPIRY_BUFFER_MS) {
      return cached.accessToken;
    }

    // Generate new token
    const privateKey = buildPrivateKey(rsaParams);
    const jwt = createJWT(
      credentials.data.clientId,
      credentials.data.authorizationUrl,
      privateKey
    );

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: jwt,
    }).toString();

    const response = await httpsRequest(credentials.data.authorizationUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body).toString(),
      },
    }, body);

    if (response.statusCode !== 200) {
      throw new Error(`OAuth failed: ${response.statusCode} ${response.body}`);
    }

    const tokenData = JSON.parse(response.body);
    const accessToken = tokenData.access_token;
    const expiry = Date.now() + (tokenData.expires_in * 1000);

    // Cache the token
    this.tokenCache.set(cacheKey, { accessToken, expiry });

    log()?.debug(`[OAuthTokenManager] Got OAuth token for ${targetDisplayName}/${instanceNum}`);
    return accessToken;
  }

  /**
   * Clear cached tokens for a target.
   */
  clearTokens(targetId: string): void {
    for (const key of this.tokenCache.keys()) {
      if (key.startsWith(`${targetId}:`)) {
        this.tokenCache.delete(key);
      }
    }
  }

  /**
   * Clear all cached tokens.
   */
  clearAllTokens(): void {
    this.tokenCache.clear();
  }
}
