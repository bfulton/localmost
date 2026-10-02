/**
 * Action Fetcher and Cache
 *
 * Downloads GitHub Actions from the public API and caches them locally.
 * Handles action version resolution (@v4, @main, @sha).
 */

import * as fs from 'fs';
import * as path from 'path';
import { getAppDataDirWithoutElectron } from './paths';
import { resolveWithin } from './contained-path';
import { isGitHubLogin, isGitHubRepoName } from './github-names';

// =============================================================================
// Types
// =============================================================================

export interface ActionRef {
  owner: string;
  repo: string;
  version: string; // Could be a tag (v4), branch (main), or commit SHA
  path?: string; // For actions in subdirectories (e.g., actions/cache/save)
}

export interface CachedAction {
  ref: ActionRef;
  localPath: string;
  fetchedAt: string;
  resolvedSha?: string;
}

export interface ActionMetadata {
  name: string;
  description?: string;
  author?: string;
  inputs?: Record<
    string,
    {
      description?: string;
      required?: boolean;
      default?: string;
    }
  >;
  outputs?: Record<
    string,
    {
      description?: string;
    }
  >;
  runs: {
    using: 'node12' | 'node16' | 'node20' | 'composite' | 'docker';
    main?: string;
    pre?: string;
    post?: string;
    steps?: unknown[]; // For composite actions
    image?: string; // For Docker actions
  };
}

// =============================================================================
// Constants
// =============================================================================

const CACHE_DIR_NAME = 'actions';
const CACHE_INDEX_FILE = 'index.json';
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// =============================================================================
// Cache Management
// =============================================================================

/**
 * Get the actions cache directory.
 */
export function getActionsCacheDir(): string {
  return path.join(getAppDataDirWithoutElectron(), CACHE_DIR_NAME);
}

/**
 * Ensure the cache directory exists.
 */
function ensureCacheDir(): void {
  const cacheDir = getActionsCacheDir();
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
}

/**
 * Get the cache index (list of cached actions).
 *
 * Only an entry's key and fetch time are ever used from it; see cachedEntry.
 */
function getCacheIndex(): Record<string, CachedAction> {
  const indexPath = path.join(getActionsCacheDir(), CACHE_INDEX_FILE);
  if (!fs.existsSync(indexPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Save the cache index.
 */
function saveCacheIndex(index: Record<string, CachedAction>): void {
  ensureCacheDir();
  const indexPath = path.join(getActionsCacheDir(), CACHE_INDEX_FILE);
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

/**
 * Generate a cache key for an action reference.
 */
function getCacheKey(ref: ActionRef): string {
  const base = `${ref.owner}/${ref.repo}@${ref.version}`;
  return ref.path ? `${base}/${ref.path}` : base;
}

/**
 * Get the local directory path for a cached action.
 *
 * The directory is removed before each fetch, and each part of it comes from
 * the workflow, so the reference is checked here as well as where it is
 * parsed, and the result must still be inside the cache.
 *
 * Every reference gets one directory, `<owner>/<repo>/<version>` or
 * `<owner>/<repo>/<version>@<subpath>`, and none lies inside another. The
 * version and subpath are encoded rather than flattened, so `releases/v1`
 * and `releases_v1` no longer both become `releases_v1`; and the subpath
 * shares the version's name rather than being a directory under it, where
 * o/r/x@v1 was o/r@v1's own `x` - replaced by fetching one, and followed
 * wherever a link there led when serving the other. Encoding leaves no `@`
 * in either part, so the name reads only one way.
 */
function getActionDir(ref: ActionRef): string {
  if (!isActionRef(ref)) {
    throw new Error(`Not an action reference: ${JSON.stringify(ref)}`);
  }
  const version = encodeURIComponent(ref.version);
  const name = ref.path ? `${version}@${encodeURIComponent(ref.path)}` : version;
  const cacheDir = path.resolve(getActionsCacheDir());
  const dir = path.resolve(cacheDir, ref.owner, ref.repo, name);
  if (!dir.startsWith(cacheDir + path.sep)) {
    throw new Error(`Action directory is outside the action cache: ${dir}`);
  }
  return dir;
}

/**
 * The action's directory, once what is on disk there has been checked: a
 * directory, not a link, whose real path is inside the cache's. Its path is
 * worked out from the reference, but resolving the action inside it follows
 * whatever is there, and the result is handed to steps to read.
 */
function heldActionDir(ref: ActionRef): string {
  const dir = getActionDir(ref);
  const cacheDir = fs.realpathSync(getActionsCacheDir());
  if (!fs.lstatSync(dir).isDirectory() || !fs.realpathSync(dir).startsWith(cacheDir + path.sep)) {
    throw new Error(`Action directory is not the action cache's own: ${dir}`);
  }
  return dir;
}

/**
 * An entry of the index, rebuilt from the reference it was asked for.
 *
 * The index is a file, and where an entry says its action lives would be
 * handed to steps to read and removed when it expires. So that is worked out
 * again from the reference, inside the cache, and only the fetch time is
 * taken from the file - and not one in the future, which would keep an entry
 * fresh forever.
 */
function cachedEntry(ref: ActionRef, index = getCacheIndex()): CachedAction | null {
  const cached = index[getCacheKey(ref)];
  if (!cached || typeof cached.fetchedAt !== 'string') return null;
  const fetchedAt = Date.parse(cached.fetchedAt);
  if (!(fetchedAt <= Date.now())) return null;
  try {
    return { ref, localPath: resolveActionPath(heldActionDir(ref), ref.path), fetchedAt: cached.fetchedAt };
  } catch {
    return null;
  }
}

// =============================================================================
// Action Reference Parsing
// =============================================================================

/**
 * Parse an action "uses" string into structured parts.
 *
 * Formats:
 *   - actions/checkout@v4
 *   - actions/cache/save@v3
 *   - ./local/path
 *   - docker://image:tag
 */
export function parseActionRef(uses: string): ActionRef | null {
  // Local actions
  if (uses.startsWith('./') || uses.startsWith('../')) {
    return null; // Local actions don't need fetching
  }

  // Docker actions
  if (uses.startsWith('docker://')) {
    return null; // Docker actions are handled separately
  }

  // Parse owner/repo@version format
  const match = uses.match(/^([^/]+)\/([^@/]+)(?:\/([^@]+))?@(.+)$/);
  if (!match) {
    return null;
  }

  const [, owner, repo, actionPath, version] = match;
  const ref = {
    owner,
    repo,
    version,
    path: actionPath,
  };
  return isActionRef(ref) ? ref : null;
}

/**
 * A version or subpath: `/`-separated names of letters, digits, `.`, `_`,
 * `+` and `-`, none of them empty, `.` or `..`. That covers the tags,
 * branches, SHAs and directories actions are published under, and nothing
 * that could climb out of the directory it names or change the URL it is
 * fetched from.
 */
const isRefPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.split('/').every((part) => /^[A-Za-z0-9._+-]+$/.test(part) && part !== '.' && part !== '..');

/**
 * Whether a reference is one the cache may hold. Each part of it becomes a
 * directory under the cache that a fetch removes and replaces, so the owner
 * and repo must be names GitHub would accept, and the version and subpath
 * must hold no `..`. The owner is any login GitHub has issued, older
 * accounts' included; none of those can be a dot segment or hold a `/`. A
 * version starting with `-` would read as an option.
 */
function isActionRef(ref: ActionRef): boolean {
  return (
    isGitHubLogin(ref.owner) &&
    isGitHubRepoName(ref.repo) &&
    isRefPath(ref.version) &&
    !ref.version.startsWith('-') &&
    (ref.path === undefined || isRefPath(ref.path))
  );
}

/**
 * Check if an action is a built-in that we intercept.
 */
export function isInterceptedAction(uses: string): boolean {
  const intercepted = [
    'actions/checkout',
    'actions/cache',
    'actions/cache/save',
    'actions/cache/restore',
    'actions/upload-artifact',
    'actions/download-artifact',
    'actions/setup-node',
    'actions/setup-python',
    'actions/setup-go',
  ];

  for (const prefix of intercepted) {
    if (uses.startsWith(prefix + '@')) {
      return true;
    }
  }
  return false;
}

// =============================================================================
// Fetching
// =============================================================================

/**
 * Download a tarball and extract it.
 */
function downloadAndExtract(url: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Ensure destination exists
    fs.mkdirSync(destDir, { recursive: true });

    // Use curl for download and tar for extraction (simpler than native Node)
    const { spawn } = require('child_process');

    // -f so an error page fails the download instead of reaching tar, and
    // HTTPS for every hop, so a redirect cannot hand the fetch to plain HTTP.
    const curl = spawn('curl', ['-sSfL', '--proto', '=https', '--proto-redir', '=https', '--', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tar = spawn('tar', ['-xz', '--strip-components=1', '-C', destDir], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    curl.stdout.pipe(tar.stdin);

    let curlError = '';
    let tarError = '';

    curl.stderr.on('data', (data: Buffer) => (curlError += data.toString()));
    tar.stderr.on('data', (data: Buffer) => (tarError += data.toString()));

    // Both have to succeed, so this waits for both. With -f, curl answers an
    // error page by writing nothing and exiting non-zero, and tar extracts an
    // empty stream without complaint: tar's word alone took a missing tag for
    // an empty archive, so the branch was never tried, and would take a
    // download cut off partway for a whole one.
    let curlCode: number | null | undefined;
    let tarCode: number | null | undefined;
    const settle = () => {
      if (curlCode === undefined || tarCode === undefined) return;
      if (curlCode !== 0) {
        reject(new Error(`Download failed: ${curlError || `curl exited with ${curlCode}`}`));
      } else if (tarCode !== 0) {
        reject(new Error(`Extraction failed: ${tarError}`));
      } else {
        resolve();
      }
    };
    curl.on('close', (code: number | null) => {
      curlCode = code;
      settle();
    });
    tar.on('close', (code: number | null) => {
      tarCode = code;
      settle();
    });

    curl.on('error', (err: Error) => reject(err));
    tar.on('error', (err: Error) => reject(err));
  });
}

/**
 * The directory an action runs from: its repository, or a subdirectory of it.
 *
 * The subpath is the workflow's to write (`owner/repo/sub@v1`), and the
 * directory becomes readable to the step, so it is held inside the extracted
 * repository - neither "../.." nor a symlink the repository ships may lead
 * out of it.
 */
export function resolveActionPath(actionDir: string, subPath?: string): string {
  if (!subPath) return fs.realpathSync(actionDir);
  return resolveWithin(actionDir, subPath, 'Action path', 'its repository');
}

/**
 * Fetch an action from GitHub.
 */
export async function fetchAction(ref: ActionRef): Promise<CachedAction> {
  const cacheKey = getCacheKey(ref);
  const index = getCacheIndex();

  // Check cache first
  const hit = cachedEntry(ref, index);
  if (hit && Date.now() - Date.parse(hit.fetchedAt) < MAX_CACHE_AGE_MS) {
    return hit;
  }

  // Fetch from GitHub
  const actionDir = getActionDir(ref);

  // Clean existing if present - a dangling link included, which existsSync
  // would call absent and extraction would then fail on.
  fs.rmSync(actionDir, { recursive: true, force: true });

  // Download tarball. A commit's archive is served at archive/<sha>, not
  // under refs/; anything else is a tag or, failing that, a branch.
  const archive = `https://github.com/${ref.owner}/${ref.repo}/archive`;
  if (/^[0-9a-f]{40}$/.test(ref.version)) {
    await downloadAndExtract(`${archive}/${ref.version}.tar.gz`, actionDir);
  } else {
    try {
      await downloadAndExtract(`${archive}/refs/tags/${ref.version}.tar.gz`, actionDir);
    } catch {
      // Try as a branch
      await downloadAndExtract(`${archive}/refs/heads/${ref.version}.tar.gz`, actionDir);
    }
  }

  const localPath = resolveActionPath(heldActionDir(ref), ref.path);

  // Verify action.yml exists
  if (!fs.existsSync(path.join(localPath, 'action.yml')) &&
      !fs.existsSync(path.join(localPath, 'action.yaml'))) {
    throw new Error(`No action.yml found in ${ref.owner}/${ref.repo}${ref.path ? '/' + ref.path : ''}`);
  }

  // Update cache index
  const cached: CachedAction = {
    ref,
    localPath,
    fetchedAt: new Date().toISOString(),
  };
  index[cacheKey] = cached;
  saveCacheIndex(index);

  return cached;
}

/**
 * Get a cached action if available.
 */
export function getCachedAction(ref: ActionRef): CachedAction | null {
  return cachedEntry(ref);
}

/**
 * The index's entries as stored, each with its reference if that is one the
 * cache could hold and is filed under its own key, and the entry as
 * cachedEntry rebuilds it. Otherwise both are null: nothing it says is used.
 */
function indexEntries(
  index: Record<string, CachedAction>
): Array<{ key: string; ref: ActionRef | null; cached: CachedAction | null }> {
  return Object.entries(index).map(([key, stored]) => {
    const candidate = (stored as Partial<CachedAction> | null)?.ref;
    const ref = candidate && typeof candidate === 'object' && isActionRef(candidate) && getCacheKey(candidate) === key
      ? candidate
      : null;
    return { key, ref, cached: ref && cachedEntry(ref, index) };
  });
}

/**
 * Read the action.yml metadata for a cached action.
 */
export function readActionMetadata(actionPath: string): ActionMetadata | null {
  const ymlPath = path.join(actionPath, 'action.yml');
  const yamlPath = path.join(actionPath, 'action.yaml');

  const metadataPath = fs.existsSync(ymlPath) ? ymlPath : fs.existsSync(yamlPath) ? yamlPath : null;

  if (!metadataPath) {
    return null;
  }

  // Read by the app, outside any sandbox, from a directory a checkout
  // controls; its input defaults become the step's environment. So it must be
  // the action's own file, not a link to one elsewhere - and for a local
  // action, something an earlier step left running can swap it between any
  // check and the read. So the file is opened first, without following a
  // link or waiting on a FIFO, and it is the open file that is judged: a
  // regular file with no other name, the same one the action's path names
  // once that path has been checked.
  let fd: number;
  try {
    fd = fs.openSync(metadataPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) return null;
    const checked = fs.lstatSync(
      resolveWithin(actionPath, path.basename(metadataPath), 'Action metadata', 'the action')
    );
    if (checked.dev !== opened.dev || checked.ino !== opened.ino) return null;
    const yaml = require('js-yaml');
    return yaml.load(fs.readFileSync(fd, 'utf-8')) as ActionMetadata;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// =============================================================================
// Cache Maintenance
// =============================================================================

/**
 * Clean old entries from the action cache.
 */
export function cleanActionCache(maxAgeDays = 30): { removed: number; kept: number } {
  const index = getCacheIndex();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  let removed = 0;
  let kept = 0;

  for (const { key, ref, cached } of indexEntries(index)) {
    if (!cached || now - Date.parse(cached.fetchedAt) > maxAgeMs) {
      // Remove from disk: the directory the repository was extracted into,
      // worked out from a reference that has been checked, never a path the
      // index names.
      if (ref) {
        try {
          fs.rmSync(getActionDir(ref), { recursive: true, force: true });
        } catch {
          // Ignore errors
        }
      }
      delete index[key];
      removed++;
    } else {
      kept++;
    }
  }

  saveCacheIndex(index);
  return { removed, kept };
}

/**
 * List all cached actions.
 */
export function listCachedActions(): CachedAction[] {
  return indexEntries(getCacheIndex()).flatMap(({ cached }) => (cached ? [cached] : []));
}

/**
 * Get total size of the action cache in bytes.
 */
export function getActionCacheSize(): number {
  const cacheDir = getActionsCacheDir();
  if (!fs.existsSync(cacheDir)) {
    return 0;
  }

  function getDirSize(dir: string): number {
    let size = 0;
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
      const filePath = path.join(dir, file.name);
      if (file.isDirectory()) {
        size += getDirSize(filePath);
      } else {
        size += fs.statSync(filePath).size;
      }
    }
    return size;
  }

  return getDirSize(cacheDir);
}
