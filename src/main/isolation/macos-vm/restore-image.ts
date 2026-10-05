/**
 * The restore image: downloaded from the one URL the helper's catalog named,
 * resumed where a previous download stopped, and checked against Apple's
 * published SHA-1 when Apple publishes one.
 *
 * VZMacOSRestoreImage.fetchLatestSupported names an IPSW on
 * updates.cdn-apple.com and no checksum. Apple's macOS IPSW catalog
 * (mesu.apple.com) lists the latest release's IPSW with its FirmwareSHA1,
 * but not older ones: on a macOS 27 host the image VZ offers is listed, on a
 * macOS 26 host (offered 26.6.2) it is not. So the checksum is used when
 * the catalog lists exactly the URL VZ named, and otherwise the download
 * rests on TLS to Apple's host and on the installer, which verifies the
 * Apple-signed firmware in the image before it installs any of it
 * (docs/roadmap/macos-vm-jobs.md, "Restore image").
 *
 * Every byte goes to `<name>.partial` beside the destination, opened without
 * following a link, and is renamed into place only once complete and checked.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import { isAllowedRestoreImageUrl, RESTORE_IMAGE_HOST } from './helper-client';

/** Apple's macOS IPSW catalog: the one other host this module reads. */
export const IPSW_CATALOG_URL = 'https://mesu.apple.com/assets/macos/com_apple_macOSIPSW/com_apple_macOSIPSW.xml';

/** The most of the catalog read: it is about 100 KB. */
const MAX_CATALOG_BYTES = 4 << 20;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The FirmwareSHA1 values the catalog gives `url`, from each innermost
 * <dict> whose FirmwareURL is exactly `url`: one, null for none, and an
 * error when they disagree.
 */
export function firmwareSha1For(catalogXml: string, url: string): string | null {
  const found = new Set<string>();
  const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  for (const dict of catalogXml.matchAll(/<dict>((?:(?!<dict>)[\s\S])*?)<\/dict>/g)) {
    const fields = new Map<string, string>();
    for (const pair of dict[1].matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) {
      fields.set(unescape(pair[1]), unescape(pair[2]));
    }
    if (fields.get('FirmwareURL') !== url) continue;
    const sha1 = fields.get('FirmwareSHA1');
    if (sha1 !== undefined) {
      if (!/^[0-9a-f]{40}$/.test(sha1)) throw new Error(`the IPSW catalog gives ${url} a SHA-1 that is not 40 hex`);
      found.add(sha1);
    }
  }
  if (found.size > 1) throw new Error(`the IPSW catalog gives ${url} ${found.size} different SHA-1s`);
  return found.size === 1 ? [...found][0] : null;
}

/** Reads a body to text, refusing more than `max` bytes. */
async function boundedText(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new Error(`more than ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Apple's SHA-1 for the IPSW at `url`, or null when the catalog does not list it. */
export async function publishedSha1(url: string, fetchImpl: FetchLike = fetch): Promise<string | null> {
  const response = await fetchImpl(IPSW_CATALOG_URL, { redirect: 'error' });
  if (!response.ok) throw new Error(`the IPSW catalog answered ${response.status}`);
  return firmwareSha1For(await boundedText(response, MAX_CATALOG_BYTES), url);
}

export interface DownloadOptions {
  url: string;
  /** `<data>/macos-vm/ipsw/<build>.ipsw`, from ipswPath(). */
  dest: string;
  /** Apple's SHA-1, when published. */
  sha1: string | null;
  onProgress?: (received: number, total: number) => void;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  /** Free bytes on the destination's volume. */
  freeBytes?: (dir: string) => Promise<number>;
  /** What must stay free after the download: the image still has to be installed. */
  reserveBytes: number;
}

/** What a partial download was of, so that a resume asks for the same bytes. */
interface PartialMeta {
  url: string;
  etag: string;
  total: number;
}

const defaultFreeBytes = async (dir: string): Promise<number> => {
  const stats = await fs.promises.statfs(dir);
  return stats.bavail * stats.bsize;
};

const readMeta = (file: string): PartialMeta | null => {
  try {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as PartialMeta;
    return typeof meta.url === 'string' && typeof meta.etag === 'string' && Number.isSafeInteger(meta.total) ? meta : null;
  } catch {
    return null;
  }
};

/** A regular file's size, without following a link; 0 when there is none, and an error for anything else. */
function partialSize(file: string): number {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) throw new Error(`${file} is not a regular file`);
    return st.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

async function sha1Of(file: string, signal?: AbortSignal): Promise<string> {
  const hash = crypto.createHash('sha1');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const stream = fs.createReadStream('', { fd, highWaterMark: 4 << 20 });
  for await (const chunk of stream) {
    if (signal?.aborted) {
      stream.destroy();
      throw new Error('the download was cancelled');
    }
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * Downloads the restore image to `dest`, resuming a partial download of the
 * same URL and ETag. Resolves once `dest` is complete and, when Apple
 * publishes a SHA-1, matches it. Leaves the partial file for a later resume
 * when cancelled or cut off, and removes it when it is wrong.
 */
export async function downloadRestoreImage(opts: DownloadOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!isAllowedRestoreImageUrl(opts.url)) throw new Error(`refusing to download a restore image from ${opts.url}`);
  if (!opts.dest.endsWith('.ipsw')) throw new Error(`not a restore image path: ${opts.dest}`);
  const partial = `${opts.dest}.partial`;
  const metaFile = `${partial}.json`;
  const dir = opts.dest.slice(0, opts.dest.lastIndexOf('/'));

  let have = partialSize(partial);
  const meta = readMeta(metaFile);
  if (have > 0 && (!meta || meta.url !== opts.url)) {
    fs.rmSync(partial, { force: true });
    have = 0;
  }
  const headers: Record<string, string> = {};
  if (have > 0 && meta) {
    headers.Range = `bytes=${have}-`;
    headers['If-Range'] = meta.etag;
  }
  // No redirect is followed: the catalog's URL is the file, on Apple's host.
  const response = await fetchImpl(opts.url, { headers, redirect: 'error', ...(opts.signal ? { signal: opts.signal } : {}) });
  if (response.status !== 200 && response.status !== 206) throw new Error(`${RESTORE_IMAGE_HOST} answered ${response.status}`);
  const etag = response.headers.get('etag') ?? '';
  let total: number;
  if (response.status === 206 && have > 0) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    if (!range || Number(range[1]) !== have || Number(range[3]) !== meta?.total) {
      await response.body?.cancel();
      fs.rmSync(partial, { force: true });
      fs.rmSync(metaFile, { force: true });
      throw new Error('the server resumed a different range or file; the partial download was discarded, start again');
    }
    total = Number(range[3]);
  } else {
    // A full answer: the partial (if any) is stale.
    have = 0;
    total = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(total) || total <= 0) {
      await response.body?.cancel();
      throw new Error('the restore image has no length');
    }
  }
  const free = await (opts.freeBytes ?? defaultFreeBytes)(dir);
  if (free - (total - have) < opts.reserveBytes) {
    await response.body?.cancel();
    const gib = (n: number) => (n / 2 ** 30).toFixed(1);
    throw new Error(
      `not enough free disk: the restore image needs ${gib(total - have)} GiB more, and ${gib(opts.reserveBytes)} GiB must stay free; ${gib(free)} GiB is free`
    );
  }
  const metaFd = fs.openSync(metaFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(metaFd, JSON.stringify({ url: opts.url, etag, total } satisfies PartialMeta));
  } finally {
    fs.closeSync(metaFd);
  }

  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | (have > 0 ? fs.constants.O_APPEND : fs.constants.O_TRUNC);
  const fd = fs.openSync(partial, flags, 0o600);
  let received = have;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('the restore image has no body');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.length > total) throw new Error('the server sent more than the restore image\'s length');
      fs.writeSync(fd, value);
      received += value.length;
      opts.onProgress?.(received, total);
    }
  } finally {
    fs.closeSync(fd);
  }
  if (received !== total) throw new Error(`the download stopped at ${received} of ${total} bytes; it resumes from there`);
  if (opts.sha1) {
    const actual = await sha1Of(partial, opts.signal);
    if (actual !== opts.sha1) {
      fs.rmSync(partial, { force: true });
      fs.rmSync(metaFile, { force: true });
      throw new Error(`the restore image's SHA-1 is ${actual}, not the ${opts.sha1} Apple publishes; it was discarded`);
    }
  }
  // Never over something already there: link() fails on an existing name.
  fs.linkSync(partial, opts.dest);
  fs.rmSync(partial, { force: true });
  fs.rmSync(metaFile, { force: true });
}
