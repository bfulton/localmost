/**
 * The restore image's download: resumed, bounded by free disk, checked
 * against Apple's SHA-1 when published, and put in place only when whole.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { downloadRestoreImage, firmwareSha1For, publishedSha1, IPSW_CATALOG_URL, FetchLike } from './restore-image';
import { shortTempDir } from '../../test-utils/vm-fixtures';

const URL_ = 'https://updates.cdn-apple.com/2026FallFCS/59241290/UniversalMac_27.0.1_26A434_Restore.ipsw';

const catalog = (entries: Array<{ url: string; sha1?: string }>) =>
  `<?xml version="1.0"?><plist version="1.0"><dict><key>MobileDeviceSoftwareVersionsByVersion</key><dict><key>1</key><dict>` +
  entries
    .map(
      (e, i) =>
        `<key>Mac${i}</key><dict><key>26A434</key><dict><key>Restore</key><dict><key>BuildVersion</key><string>26A434</string>` +
        (e.sha1 ? `<key>FirmwareSHA1</key>\n<string>${e.sha1}</string>` : '') +
        `<key>FirmwareURL</key><string>${e.url}</string><key>ProductVersion</key><string>27.0.1</string></dict></dict></dict>`
    )
    .join('') +
  `</dict></dict></dict></plist>`;

describe("Apple's published SHA-1", () => {
  const sha = 'a'.repeat(40);

  it('is the one every entry for exactly that URL gives', () => {
    expect(firmwareSha1For(catalog([{ url: URL_, sha1: sha }, { url: URL_, sha1: sha }, { url: `${URL_}x`, sha1: 'b'.repeat(40) }]), URL_)).toBe(sha);
    expect(firmwareSha1For(catalog([{ url: URL_ }]), URL_)).toBeNull();
    expect(firmwareSha1For(catalog([{ url: `${URL_}.old`, sha1: sha }]), URL_)).toBeNull();
  });

  it('is refused when entries disagree, or one is not 40 hex', () => {
    expect(() => firmwareSha1For(catalog([{ url: URL_, sha1: sha }, { url: URL_, sha1: 'b'.repeat(40) }]), URL_)).toThrow(/different/);
    expect(() => firmwareSha1For(catalog([{ url: URL_, sha1: 'zz' }]), URL_)).toThrow(/40 hex/);
  });

  it('is read from the catalog URL, and a catalog past its bound is refused', async () => {
    const asked: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      asked.push(url);
      return new Response(catalog([{ url: URL_, sha1: sha }]));
    };
    expect(await publishedSha1(URL_, fetchImpl)).toBe(sha);
    expect(asked).toEqual([IPSW_CATALOG_URL]);
    await expect(publishedSha1(URL_, async () => new Response('x'.repeat(5 << 20)))).rejects.toThrow(/more than/);
  });
});

describe('downloadRestoreImage', () => {
  let dir: string;
  let dest: string;
  const image = crypto.randomBytes(256 * 1024);
  const sha1 = crypto.createHash('sha1').update(image).digest('hex');
  const plenty = async () => 100 * 2 ** 30;

  beforeEach(() => {
    dir = shortTempDir();
    dest = path.join(dir, '26A434.ipsw');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A server for the image that honours a Range with the right If-Range, as a CDN does. */
  const server = (opts: { etag?: string; ignoreRange?: boolean; cutAt?: number; badRange?: boolean } = {}) => {
    const requests: Array<Record<string, string>> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ url, ...headers });
      const etag = opts.etag ?? '"v1"';
      const range = /^bytes=(\d+)-$/.exec(headers.Range ?? '');
      if (range && !opts.ignoreRange && headers['If-Range'] === etag) {
        const from = opts.badRange ? 1 : Number(range[1]);
        return new Response(image.subarray(from), {
          status: 206,
          headers: { etag, 'content-range': `bytes ${from}-${image.length - 1}/${image.length}`, 'content-length': String(image.length - from) },
        });
      }
      const body = opts.cutAt !== undefined ? image.subarray(0, opts.cutAt) : image;
      return new Response(body, { status: 200, headers: { etag, 'content-length': String(image.length) } });
    };
    return { requests, fetchImpl };
  };

  it("downloads the whole image, checks Apple's SHA-1, and only then puts it in place", async () => {
    const { fetchImpl } = server();
    const progress: number[] = [];
    await downloadRestoreImage({ url: URL_, dest, sha1, fetchImpl, freeBytes: plenty, reserveBytes: 0, onProgress: (r) => progress.push(r) });
    expect(fs.readFileSync(dest).equals(image)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['26A434.ipsw']);
    expect(progress[progress.length - 1]).toBe(image.length);
  });

  it('resumes a download cut off, asking for the rest of the same file', async () => {
    const cut = server({ cutAt: 100_000 });
    await expect(downloadRestoreImage({ url: URL_, dest, sha1, fetchImpl: cut.fetchImpl, freeBytes: plenty, reserveBytes: 0 })).rejects.toThrow(/resumes/);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.statSync(`${dest}.partial`).size).toBe(100_000);

    const rest = server();
    await downloadRestoreImage({ url: URL_, dest, sha1, fetchImpl: rest.fetchImpl, freeBytes: plenty, reserveBytes: 0 });
    expect(rest.requests[0]).toMatchObject({ Range: 'bytes=100000-', 'If-Range': '"v1"' });
    expect(fs.readFileSync(dest).equals(image)).toBe(true);
  });

  it('starts over when the file changed (a new ETag), or the server sends it whole', async () => {
    await downloadRestoreImage({ url: URL_, dest: path.join(dir, 'x.ipsw'), sha1: null, fetchImpl: server({ cutAt: 10 }).fetchImpl, freeBytes: plenty, reserveBytes: 0 }).catch(() => {});
    fs.renameSync(path.join(dir, 'x.ipsw.partial'), `${dest}.partial`);
    fs.renameSync(path.join(dir, 'x.ipsw.partial.json'), `${dest}.partial.json`);
    const changed = server({ etag: '"v2"' });
    await downloadRestoreImage({ url: URL_, dest, sha1, fetchImpl: changed.fetchImpl, freeBytes: plenty, reserveBytes: 0 });
    expect(fs.readFileSync(dest).equals(image)).toBe(true);
  });

  it('discards a partial download when the server resumes a different range', async () => {
    await downloadRestoreImage({ url: URL_, dest, sha1, fetchImpl: server({ cutAt: 5000 }).fetchImpl, freeBytes: plenty, reserveBytes: 0 }).catch(() => {});
    await expect(downloadRestoreImage({ url: URL_, dest, sha1, fetchImpl: server({ badRange: true }).fetchImpl, freeBytes: plenty, reserveBytes: 0 })).rejects.toThrow(
      /different range/
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("discards an image that is not Apple's", async () => {
    const { fetchImpl } = server();
    await expect(downloadRestoreImage({ url: URL_, dest, sha1: 'f'.repeat(40), fetchImpl, freeBytes: plenty, reserveBytes: 0 })).rejects.toThrow(/SHA-1/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses before writing anything when the disk would fall below its reserve', async () => {
    const { fetchImpl } = server();
    await expect(
      downloadRestoreImage({ url: URL_, dest, sha1, fetchImpl, freeBytes: async () => image.length + 1000, reserveBytes: 2000 })
    ).rejects.toThrow(/not enough free disk/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('downloads only from the catalog host, and never over a link or an image already there', async () => {
    const { fetchImpl, requests } = server();
    await expect(downloadRestoreImage({ url: 'https://evil.example/x.ipsw', dest, sha1, fetchImpl, freeBytes: plenty, reserveBytes: 0 })).rejects.toThrow(/refusing/);
    expect(requests).toEqual([]);

    fs.symlinkSync(path.join(dir, 'elsewhere'), `${dest}.partial`);
    await expect(downloadRestoreImage({ url: URL_, dest, sha1, fetchImpl, freeBytes: plenty, reserveBytes: 0 })).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, 'elsewhere'))).toBe(false);
    fs.unlinkSync(`${dest}.partial`);

    fs.writeFileSync(dest, 'an image already here');
    await expect(downloadRestoreImage({ url: URL_, dest, sha1, fetchImpl, freeBytes: plenty, reserveBytes: 0 })).rejects.toThrow(/EEXIST/);
    expect(fs.readFileSync(dest, 'utf8')).toBe('an image already here');
  });
});
