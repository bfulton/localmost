import { describe, it, expect } from '@jest/globals';
import { sanitizeLogMessage, sanitizeForLogging } from './security';

// Fixtures are built at runtime so no token-shaped literal sits in the source
// for a secret scanner to flag.
const alnum = (n: number, seed = 'aB3'): string => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
const hex64 = 'a1b2c3d4'.repeat(8);

describe('sanitizeLogMessage', () => {
  it('redacts every GitHub token prefix the app can meet', () => {
    // Classic, OAuth, user-to-server, installation and refresh tokens. The
    // refresh token (ghr_) is the long one GitHub App auth persists.
    for (const [prefix, length] of [['ghp_', 36], ['gho_', 36], ['ghu_', 36], ['ghs_', 36], ['ghr_', 76]] as const) {
      const token = `${prefix}${alnum(length)}`;
      const out = sanitizeLogMessage(`token=${token} end`);
      expect(out).not.toContain(token);
      expect(out).toContain('[REDACTED_GH_TOKEN]');
    }
  });

  it('redacts a fine-grained personal access token', () => {
    // github_pat_<22>_<59>: the format GitHub now recommends, which the gh[pousr]_
    // rule never matched.
    const token = `github_pat_${alnum(22)}_${alnum(59)}`;
    const out = sanitizeLogMessage(`using ${token} for the API`);
    expect(out).not.toContain(token);
    expect(out).not.toContain(alnum(59));
    expect(out).toBe('using [REDACTED_GH_TOKEN] for the API');
  });

  it("redacts a worker's broker key from its keyed URL", () => {
    // The /w/<key> prefix is the whole boundary between one worker's broker
    // session and another's; a logged key is a usable one.
    const out = sanitizeLogMessage(`GET http://127.0.0.1:8787/w/${hex64}/message?status=online`);
    expect(out).not.toContain(hex64);
    expect(out).toBe('GET http://127.0.0.1:8787/w/[REDACTED]/message?status=online');
  });

  it("redacts the egress proxy's per-worker token from the proxy URL", () => {
    const token = 'c0ffee'.repeat(8);
    const out = sanitizeLogMessage(`HTTPS_PROXY=http://localmost:${token}@127.0.0.1:53211`);
    expect(out).not.toContain(token);
    expect(out).toBe('HTTPS_PROXY=http://[REDACTED]@127.0.0.1:53211');
  });

  it('redacts user:password credentials in any URL', () => {
    expect(sanitizeLogMessage('clone https://x-access-token:s3cret-value@github.com/o/r.git'))
      .toBe('clone https://[REDACTED]@github.com/o/r.git');
    expect(sanitizeLogMessage('db postgres://app:hunter2@db.internal:5432/main'))
      .toBe('db postgres://[REDACTED]@db.internal:5432/main');
  });

  it('leaves URLs without credentials, and other digests, readable', () => {
    // Only the /w/ key is a secret; a sha256 elsewhere is an identifier people
    // need to read in the log.
    const plain = `fetched https://github.com/o/r/archive/${hex64}.tar.gz from git@github.com:o/r`;
    expect(sanitizeLogMessage(plain)).toBe(plain);
  });

  it('removes all three secrets when they share a line', () => {
    const proxyToken = 'abc123abc123';
    const pat = `github_pat_${alnum(82)}`;
    const line = `http://localmost:${proxyToken}@127.0.0.1:9/ ${pat} http://127.0.0.1:8787/w/${hex64}/`;
    const out = sanitizeLogMessage(line);
    expect(out).not.toContain(proxyToken);
    expect(out).not.toContain(pat);
    expect(out).not.toContain(hex64);
  });
});

describe('sanitizeForLogging', () => {
  it('applies the same rules to an error message and stack', () => {
    const err = new Error(`connect failed for http://127.0.0.1:8787/w/${hex64}/acquirejob`);
    expect(sanitizeForLogging(err)).not.toContain(hex64);
  });
});
