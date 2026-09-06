/**
 * Parse a raw Docker Engine API request into the typed view the filtering
 * socket evaluates, and classify it by the CLI-shaped action it represents.
 *
 * The verb-to-endpoint map is part of the reviewed surface: policy is written
 * in terms of `pull`, `run` and `build`, so the mapping from those verbs to
 * API paths is asserted in tests rather than left implicit. Anything the map
 * does not name classifies as `other`, which the evaluator refuses. See
 * docs/superpowers/specs/2026-09-05-docker-isolation-design.md.
 *
 * Pure: imports nothing from the rest of the app.
 */

import { URL } from 'url';

export type DockerAction =
  | 'ping'
  | 'version'
  | 'info'
  | 'inspect'
  | 'list'
  | 'pull'
  | 'create'
  | 'start'
  | 'attach'
  | 'wait'
  | 'remove'
  | 'kill'
  | 'stop'
  | 'logs'
  | 'build'
  | 'other';

export interface DockerRequest {
  /** GET, POST, DELETE. */
  method: string;
  /** The path without the /vX.YY version prefix. */
  path: string;
  /** The vX.YY prefix if present. */
  apiVersion?: string;
  /** First value per key, which is how the daemon reads a repeated key. */
  query: Record<string, string>;
  /** The parsed JSON body when the content type is JSON; undefined otherwise. */
  body?: unknown;
  /** Set when the content type promised JSON and the body did not parse. */
  bodyError?: string;
  /**
   * Set when the request target is not a plain origin-form path. The filter
   * refuses these rather than guessing: a target carrying an authority
   * (`//evil/x`, `http://evil/x`) is read one way by the URL parser here and
   * another by the daemon, and judging one while forwarding the other is how a
   * filter gets talked past.
   */
  targetError?: string;
  raw: { method: string; url: string; headers: Record<string, string>; body: Buffer };
}

const VERSION_PREFIX = /^\/(v\d+\.\d+)(\/.*)$/;

const headerValue = (headers: Record<string, string>, name: string): string | undefined => {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
};

const isJsonContentType = (contentType: string | undefined): boolean =>
  contentType !== undefined && contentType.split(';')[0].trim().toLowerCase() === 'application/json';

export function parseDockerRequest(raw: DockerRequest['raw']): DockerRequest {
  // Only origin-form is accepted. Anything else either throws here (`//`,
  // `http://[`) or parses to a different path than the daemon will read, and
  // both are refusals rather than guesses.
  if (!raw.url.startsWith('/') || raw.url.startsWith('//')) {
    return {
      method: raw.method, path: raw.url, query: {}, raw,
      targetError: `request target "${raw.url}" is not a plain path; the localmost docker socket accepts origin-form targets only`,
    };
  }

  // The base is a placeholder so a path-only URL parses; only pathname and
  // search are read from the result.
  let url: URL;
  try {
    url = new URL(raw.url, 'http://docker');
  } catch {
    return {
      method: raw.method, path: raw.url, query: {}, raw,
      targetError: `request target "${raw.url}" could not be parsed`,
    };
  }

  let path = url.pathname;
  let apiVersion: string | undefined;
  const versioned = VERSION_PREFIX.exec(path);
  if (versioned) {
    apiVersion = versioned[1];
    path = versioned[2];
  }

  const query: Record<string, string> = {};
  for (const key of url.searchParams.keys()) {
    if (!(key in query)) query[key] = url.searchParams.get(key)!;
  }

  const req: DockerRequest = { method: raw.method, path, apiVersion, query, raw };

  if (isJsonContentType(headerValue(raw.headers, 'content-type')) && raw.body.length > 0) {
    try {
      req.body = JSON.parse(raw.body.toString('utf8'));
    } catch (e) {
      req.bodyError = `malformed JSON body: ${(e as Error).message}`;
    }
  }

  return req;
}

/** One container id or name: a single path segment. */
const ID = '[^/]+';

/** The reviewed verb-to-endpoint map. Order matters only for readability; the patterns are disjoint. */
const ENDPOINTS: ReadonlyArray<{ method: string; path: RegExp; action: DockerAction }> = [
  { method: 'GET', path: /^\/_ping$/, action: 'ping' },
  // The CLI pings with HEAD first and falls back to GET; both are the same check.
  { method: 'HEAD', path: /^\/_ping$/, action: 'ping' },
  { method: 'GET', path: /^\/version$/, action: 'version' },
  { method: 'GET', path: /^\/info$/, action: 'info' },
  { method: 'GET', path: new RegExp(`^/containers/${ID}/json$`), action: 'inspect' },
  // Listing is its own action, never the baseline: it enumerates every
  // container on the daemon, including other jobs'.
  { method: 'GET', path: /^\/containers\/json$/, action: 'list' },
  { method: 'POST', path: /^\/images\/create$/, action: 'pull' },
  { method: 'POST', path: /^\/containers\/create$/, action: 'create' },
  { method: 'POST', path: new RegExp(`^/containers/${ID}/start$`), action: 'start' },
  { method: 'POST', path: new RegExp(`^/containers/${ID}/attach$`), action: 'attach' },
  { method: 'POST', path: new RegExp(`^/containers/${ID}/wait$`), action: 'wait' },
  { method: 'POST', path: new RegExp(`^/containers/${ID}/kill$`), action: 'kill' },
  { method: 'POST', path: new RegExp(`^/containers/${ID}/stop$`), action: 'stop' },
  // A read about the job's own container, like inspect.
  { method: 'GET', path: new RegExp(`^/containers/${ID}/logs$`), action: 'logs' },
  { method: 'DELETE', path: new RegExp(`^/containers/${ID}$`), action: 'remove' },
  { method: 'POST', path: /^\/build$/, action: 'build' },
];

/** Per-container endpoints, for scoping an action to the containers this socket created. */
const CONTAINER_ID_PATHS: ReadonlyArray<RegExp> = [
  new RegExp(`^/containers/(${ID})/json$`),
  new RegExp(`^/containers/(${ID})/start$`),
  new RegExp(`^/containers/(${ID})/attach$`),
  new RegExp(`^/containers/(${ID})/wait$`),
  new RegExp(`^/containers/(${ID})/kill$`),
  new RegExp(`^/containers/(${ID})/stop$`),
  new RegExp(`^/containers/(${ID})/logs$`),
  new RegExp(`^/containers/(${ID})$`),
];

/**
 * The container a request addresses, or undefined when it addresses none.
 * The daemon accepts a unique id prefix as well as the full id, so a caller
 * comparing against known ids must account for prefixes.
 */
export function containerIdFrom(req: DockerRequest): string | undefined {
  for (const pattern of CONTAINER_ID_PATHS) {
    const match = pattern.exec(req.path);
    if (match) return match[1];
  }
  return undefined;
}

export function classifyDockerRequest(req: DockerRequest): DockerAction {
  for (const endpoint of ENDPOINTS) {
    if (endpoint.method === req.method && endpoint.path.test(req.path)) return endpoint.action;
  }
  return 'other';
}
