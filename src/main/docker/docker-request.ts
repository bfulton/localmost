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
  | 'network-create'
  | 'network-inspect'
  | 'network-remove'
  | 'network-list'
  | 'image-inspect'
  | 'buildkit'
  | 'build'
  | 'other';

export interface DockerRequest {
  /** GET, POST, DELETE. */
  method: string;
  /** The path without the /vX.YY version prefix. */
  path: string;
  /** The vX.YY prefix if present. */
  apiVersion?: string;
  /**
   * The first value per key. A query that repeats a key is refused
   * (targetError), save a list parameter the filter does not judge, so every
   * key read here has one value.
   */
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

/**
 * The body's media type as the daemon's Go server takes it
 * (mime.ParseMediaType): the Content-Type up to its parameters, trimmed and
 * lowercased, or '' when there is none. Go keeps the type even when the
 * parameters after it are malformed, so they are not looked at here either.
 */
export function mediaTypeOf(req: DockerRequest): string {
  const value = headerValue(req.raw.headers, 'content-type');
  return value === undefined ? '' : value.split(';')[0].trim().toLowerCase();
}

/**
 * Query parameters a client sends once per value, by endpoint, and every
 * daemon reads as the whole list: a build's tags (`docker build -t a -t b`,
 * moby's r.Form["t"], Podman's []string field). The filter judges none of
 * them. Only the exact spelling repeats; another casing of it is still
 * refused, since moby would not read it at all.
 */
const LIST_PARAMS: Readonly<Record<string, ReadonlySet<string>>> = {
  '/build': new Set(['t']),
};

/**
 * Why a query string could be read as different parameters by another
 * decoder, or undefined when it cannot.
 *
 * The filter forwards the query as it arrived, so the daemon decodes it
 * again, and daemons disagree. moby reads the first value of a repeated key
 * and answers 400 to a ";" or a bad escape; Podman's gorilla/schema keeps the
 * last value, matches names case-insensitively, and reads past both. Judging
 * `fromImage=postgres&fromImage=evil.example.com/x` as postgres would hand
 * Podman a pull of the other, on the docker.io credential. So the forms on
 * which they differ are refused rather than modelled: a key given more than
 * once, in any casing or spelling of it, a ";", and a "%" that does not start
 * a two-digit escape. None of them is something a client's encoder produces,
 * save the lists in LIST_PARAMS.
 */
function ambiguousQuery(target: string, path: string, params: URLSearchParams): string | undefined {
  const mark = target.indexOf('?');
  const search = mark === -1 ? '' : target.slice(mark + 1);
  if (search.includes(';')) return 'has a ";" in its query, which daemons split on differently';
  if (/%(?![0-9A-Fa-f]{2})/.test(search)) return 'has a "%" in its query that does not start an escape';
  const lists = LIST_PARAMS[path];
  const seen = new Map<string, string>();
  for (const key of params.keys()) {
    const folded = key.toLowerCase();
    const first = seen.get(folded);
    if (first !== undefined && !(first === key && lists?.has(key))) {
      return `names the query parameter "${key}" more than once, which daemons resolve differently`;
    }
    seen.set(folded, key);
  }
  return undefined;
}

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
  // A request target has no fragment. The URL parser here would end the path
  // at '#' and hide the rest, query included, while the daemon reads it as
  // part of the target, so what was judged would not be what is forwarded.
  if (raw.url.includes('#')) {
    return {
      method: raw.method, path: raw.url, query: {}, raw,
      targetError: `request target "${raw.url}" carries a fragment; the localmost docker socket accepts origin-form targets only`,
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

  const queryError = ambiguousQuery(raw.url, path, url.searchParams);
  if (queryError) {
    return {
      method: raw.method, path, apiVersion, query: {}, raw,
      targetError: `request target "${raw.url}" ${queryError}; the localmost docker socket accepts only a query every daemon reads one way`,
    };
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
  // The reference may carry a registry, a path and a tag, so it is anything up
  // to the trailing /json. Listing is deliberately absent: it is daemon-wide.
  { method: 'GET', path: /^\/images\/(?!json$).+\/json$/, action: 'image-inspect' },
  { method: 'POST', path: /^\/containers\/create$/, action: 'create' },
  { method: 'POST', path: new RegExp(`^/containers/${ID}/start$`), action: 'start' },
  { method: 'POST', path: new RegExp(`^/containers/${ID}/attach$`), action: 'attach' },
  { method: 'POST', path: new RegExp(`^/containers/${ID}/wait$`), action: 'wait' },
  { method: 'POST', path: new RegExp(`^/containers/${ID}/kill$`), action: 'kill' },
  { method: 'POST', path: new RegExp(`^/containers/${ID}/stop$`), action: 'stop' },
  // A read about the job's own container, like inspect.
  { method: 'GET', path: new RegExp(`^/containers/${ID}/logs$`), action: 'logs' },
  { method: 'DELETE', path: new RegExp(`^/containers/${ID}$`), action: 'remove' },
  { method: 'POST', path: /^\/networks\/create$/, action: 'network-create' },
  { method: 'GET', path: new RegExp(`^/networks/${ID}$`), action: 'network-inspect' },
  { method: 'DELETE', path: new RegExp(`^/networks/${ID}$`), action: 'network-remove' },
  // Listing enumerates the daemon, like the container list; no key grants it.
  { method: 'GET', path: /^\/networks$/, action: 'network-list' },
  { method: 'POST', path: /^\/build$/, action: 'build' },
  // BuildKit's session and stream. Named so the refusal can say why, rather
  // than falling through to "unknown endpoint".
  { method: 'POST', path: /^\/grpc$/, action: 'buildkit' },
  { method: 'POST', path: /^\/session$/, action: 'buildkit' },
];

/** The image reference an inspect addresses, decoded, or undefined. */
export function imageRefFrom(req: DockerRequest): string | undefined {
  const match = /^\/images\/(.+)\/json$/.exec(req.path);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Per-network endpoints, for scoping to networks this socket created. */
const NETWORK_ID_PATHS: ReadonlyArray<RegExp> = [new RegExp(`^/networks/(${ID})$`)];

/** The network a request addresses, or undefined when it addresses none. */
export function networkIdFrom(req: DockerRequest): string | undefined {
  for (const pattern of NETWORK_ID_PATHS) {
    const match = pattern.exec(req.path);
    if (match) return match[1];
  }
  return undefined;
}

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
