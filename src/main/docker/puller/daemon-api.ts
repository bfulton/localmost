/**
 * The few Docker Engine API calls the puller and the cache refresh make on a
 * VM's docker.sock: inspect, load, tag, list and remove images.
 *
 * With guest root, dockerd's answers are the job's to choose, and Electron
 * main is shared by every job, so every answer here is hostile input (contract
 * §5.3): it is capped at MAX_JSON_BODY_BYTES while it streams (past the cap,
 * the connection is destroyed), parsed, schema-checked, and any digest in it
 * validated before it is used.
 */

import * as http from 'http';
import type * as net from 'net';
import { Readable } from 'stream';
import { DIGEST_RE } from '../../vm/paths';
import { cleanText } from './clean-text';

/** The cap on any daemon answer that is buffered to be parsed (contract §5.3). */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

export class DaemonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonError';
  }
}

export const OVERSIZED = 'the Docker VM sent an oversized answer';

/**
 * Opens a connection for a VM's docker.sock. Tests only: they serve the mock
 * daemon on TCP, because a unix socket path under a job's TMPDIR can exceed
 * the 103-byte limit. Without it, the connection is to the socket itself.
 */
export type DaemonConnector = (socketPath: string) => net.Socket;

/** A VM's docker.sock, and how to reach it. */
export interface DaemonEndpoint {
  socketPath: string;
  connect?: DaemonConnector;
}

interface Answer {
  status: number;
  body: Buffer;
}

function call(
  daemon: DaemonEndpoint,
  method: string,
  apiPath: string,
  signal: AbortSignal | undefined,
  body?: Readable,
  headers: Record<string, string> = {}
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const connect = daemon.connect;
    const target = connect ? { createConnection: () => connect(daemon.socketPath) } : { socketPath: daemon.socketPath };
    const req = http.request({ ...target, method, path: apiPath, headers: { host: 'docker', ...headers }, signal }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_JSON_BODY_BYTES) {
          res.destroy();
          req.destroy();
          fail(new DaemonError(OVERSIZED));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
      });
      res.on('error', (error) => fail(error));
    });
    req.on('error', (error) => {
      const aborted = (error as NodeJS.ErrnoException).name === 'AbortError';
      fail(aborted ? new DaemonError('the pull was cancelled') : new DaemonError(`the Docker VM did not answer: ${cleanText(error.message, 200)}`));
    });
    if (body) {
      body.on('error', (error) => {
        req.destroy(error);
        fail(error);
      });
      body.pipe(req);
    } else {
      req.end();
    }
  });
}

function json(answer: Answer): unknown {
  if (answer.body.length === 0) return undefined;
  try {
    return JSON.parse(answer.body.toString('utf-8'));
  } catch {
    throw new DaemonError('the Docker VM sent an answer that is not JSON');
  }
}

/** The daemon's `{ message }` on an error answer, made safe to show. */
function messageOf(answer: Answer): string {
  try {
    const body = json(answer);
    if (typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string') {
      return cleanText((body as { message: string }).message, 300);
    }
  } catch {
    // Not JSON: the status is all there is.
  }
  return `status ${answer.status}`;
}

function hexOf(digest: string): string {
  if (!DIGEST_RE.test(digest)) throw new DaemonError(`not a sha256 digest: ${cleanText(digest, 100)}`);
  return digest.slice('sha256:'.length);
}

/**
 * Whether the VM already has the image whose id is `configDigest`: a 200
 * whose `Id` is exactly that digest. The image id is the config digest, so
 * this finds an image loaded without a name.
 */
export async function hasImage(daemon: DaemonEndpoint, configDigest: string, signal?: AbortSignal): Promise<boolean> {
  const answer = await call(daemon, 'GET', `/images/sha256:${hexOf(configDigest)}/json`, signal);
  if (answer.status === 404) return false;
  if (answer.status !== 200) throw new DaemonError(`the Docker VM could not inspect ${configDigest}: ${messageOf(answer)}`);
  const body = json(answer);
  if (typeof body !== 'object' || body === null || typeof (body as { Id?: unknown }).Id !== 'string') {
    throw new DaemonError('the Docker VM sent an image inspect answer with no Id');
  }
  const id = (body as { Id: string }).Id;
  if (!DIGEST_RE.test(id)) throw new DaemonError('the Docker VM sent a malformed image id');
  return id === configDigest;
}

/**
 * Load an archive. The answer is the load's JSON message stream, capped and
 * parsed: an error in it fails the load, and every image id it names must be
 * a valid digest. Returns the ids it named.
 */
export async function loadImage(daemon: DaemonEndpoint, archive: Readable, signal?: AbortSignal): Promise<string[]> {
  const answer = await call(daemon, 'POST', '/images/load?quiet=1', signal, archive, {
    'content-type': 'application/x-tar',
    'transfer-encoding': 'chunked',
  });
  if (answer.status !== 200) throw new DaemonError(`the Docker VM refused the image: ${messageOf(answer)}`);
  const ids: string[] = [];
  for (const line of answer.body.toString('utf-8').split('\n')) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      throw new DaemonError('the Docker VM sent a load answer that is not JSON');
    }
    if (typeof message !== 'object' || message === null) throw new DaemonError('the Docker VM sent a malformed load answer');
    const m = message as { error?: unknown; errorDetail?: { message?: unknown }; stream?: unknown };
    if (m.error !== undefined || m.errorDetail !== undefined) {
      const text = typeof m.errorDetail?.message === 'string' ? m.errorDetail.message : String(m.error);
      throw new DaemonError(`the Docker VM refused the image: ${cleanText(text, 300)}`);
    }
    if (typeof m.stream === 'string') {
      const loaded = /^Loaded image ID: (\S+)/.exec(m.stream.trim());
      if (loaded) {
        if (!DIGEST_RE.test(loaded[1])) throw new DaemonError('the Docker VM sent a malformed image id');
        ids.push(loaded[1]);
      }
    }
  }
  return ids;
}

/**
 * `repo` and `tag` as the tag endpoint takes them: the image's name (a
 * registry host, then path components in Docker's reference grammar, so no
 * empty or `..` component), and a tag.
 */
const REPO_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)+$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export async function tagImage(daemon: DaemonEndpoint, configDigest: string, repo: string, tag: string, signal?: AbortSignal): Promise<void> {
  if (!REPO_RE.test(repo) || !TAG_RE.test(tag)) throw new DaemonError(`not a name to tag: ${cleanText(`${repo}:${tag}`, 300)}`);
  const query = new URLSearchParams({ repo, tag }).toString();
  const answer = await call(daemon, 'POST', `/images/sha256:${hexOf(configDigest)}/tag?${query}`, signal);
  if (answer.status !== 201 && answer.status !== 200) {
    throw new DaemonError(`the Docker VM could not tag ${configDigest} as ${repo}:${tag}: ${messageOf(answer)}`);
  }
}

export interface ListedImage {
  Id: string;
  RepoTags: string[];
}

/** Every image in the VM, with its tags; an entry that is not an image is refused. */
export async function listImages(daemon: DaemonEndpoint, signal?: AbortSignal): Promise<ListedImage[]> {
  const answer = await call(daemon, 'GET', '/images/json?all=1', signal);
  if (answer.status !== 200) throw new DaemonError(`the Docker VM could not list images: ${messageOf(answer)}`);
  const body = json(answer);
  if (!Array.isArray(body)) throw new DaemonError('the Docker VM sent an image list that is not a list');
  return body.map((entry): ListedImage => {
    if (typeof entry !== 'object' || entry === null) throw new DaemonError('the Docker VM sent a malformed image list');
    const e = entry as { Id?: unknown; RepoTags?: unknown };
    if (typeof e.Id !== 'string' || !DIGEST_RE.test(e.Id)) throw new DaemonError('the Docker VM sent a malformed image id');
    const tags = Array.isArray(e.RepoTags) ? e.RepoTags.filter((t): t is string => typeof t === 'string' && t.length <= 512) : [];
    return { Id: e.Id, RepoTags: tags };
  });
}

/**
 * Remove an image by id (with force), or untag one name. A 404 is not an
 * error: what was to go is gone.
 */
export async function removeImage(daemon: DaemonEndpoint, target: { id: string } | { tag: string }, signal?: AbortSignal): Promise<void> {
  const name = 'id' in target ? `sha256:${hexOf(target.id)}` : target.tag;
  // A name goes into the path as the docker CLI sends it, so it may hold only
  // what an image reference can: no '?', '#', '%', space or '..'.
  if (!('id' in target) && (!/^[A-Za-z0-9._\-/:@]{1,512}$/.test(name) || name.includes('..'))) {
    throw new DaemonError(`not an image name: ${cleanText(name, 200)}`);
  }
  const query = 'id' in target ? '?force=1' : '?noprune=1';
  const answer = await call(daemon, 'DELETE', `/images/${name}${query}`, signal);
  if (answer.status !== 200 && answer.status !== 404) {
    throw new DaemonError(`the Docker VM could not remove ${cleanText(name, 200)}: ${messageOf(answer)}`);
  }
}
