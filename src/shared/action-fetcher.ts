/**
 * Action Fetcher and Cache
 *
 * Downloads GitHub Actions from the public API and caches them locally.
 * Handles action version resolution (@v4, @main, @sha).
 */

import * as fs from 'fs';
import * as path from 'path';
import { getAppDataDirWithoutElectron } from './paths';

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
 */
function getActionDir(ref: ActionRef): string {
  const parts = [ref.owner, ref.repo, ref.version.replace(/[^a-zA-Z0-9.-]/g, '_')];
  if (ref.path) {
    parts.push(ref.path.replace(/\//g, '_'));
  }
  return path.join(getActionsCacheDir(), ...parts);
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
  return {
    owner,
    repo,
    version,
    path: actionPath,
  };
}

/**
 * Check if an action is a built-in that we intercept.
 */
export function isInterceptedAction(uses: string): boolean {
  const intercepted = [
    'actions/checkout',
    'actions/cache',
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

    const curl = spawn('curl', ['-sL', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn('tar', ['-xz', '--strip-components=1', '-C', destDir], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    curl.stdout.pipe(tar.stdin);

    let curlError = '';
    let tarError = '';

    curl.stderr.on('data', (data: Buffer) => (curlError += data.toString()));
    tar.stderr.on('data', (data: Buffer) => (tarError += data.toString()));

    tar.on('close', (code: number) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Extraction failed: ${tarError || curlError}`));
      }
    });

    curl.on('error', (err: Error) => reject(err));
    tar.on('error', (err: Error) => reject(err));
  });
}

/**
 * Fetch an action from GitHub.
 */
export async function fetchAction(ref: ActionRef): Promise<CachedAction> {
  const cacheKey = getCacheKey(ref);
  const index = getCacheIndex();

  // Check cache first
  if (index[cacheKey]) {
    const cached = index[cacheKey];
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    if (age < MAX_CACHE_AGE_MS && fs.existsSync(cached.localPath)) {
      return cached;
    }
  }

  // Fetch from GitHub
  const actionDir = getActionDir(ref);

  // Clean existing if present
  if (fs.existsSync(actionDir)) {
    fs.rmSync(actionDir, { recursive: true, force: true });
  }

  // Download tarball
  const tarballUrl = `https://github.com/${ref.owner}/${ref.repo}/archive/refs/${
    ref.version.match(/^[0-9a-f]{40}$/) ? '' : 'tags/'
  }${ref.version}.tar.gz`;

  try {
    await downloadAndExtract(tarballUrl, actionDir);
  } catch {
    // Try as a branch
    const branchUrl = `https://github.com/${ref.owner}/${ref.repo}/archive/refs/heads/${ref.version}.tar.gz`;
    await downloadAndExtract(branchUrl, actionDir);
  }

  // Handle subdirectory actions
  const localPath = ref.path ? path.join(actionDir, ref.path) : actionDir;

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
  const cacheKey = getCacheKey(ref);
  const index = getCacheIndex();
  const cached = index[cacheKey];

  if (cached && fs.existsSync(cached.localPath)) {
    return cached;
  }

  return null;
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

  try {
    const yaml = require('js-yaml');
    return yaml.load(fs.readFileSync(metadataPath, 'utf-8')) as ActionMetadata;
  } catch {
    return null;
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

  for (const [key, cached] of Object.entries(index)) {
    const age = now - new Date(cached.fetchedAt).getTime();
    if (age > maxAgeMs || !fs.existsSync(cached.localPath)) {
      // Remove from disk
      if (fs.existsSync(cached.localPath)) {
        try {
          fs.rmSync(cached.localPath, { recursive: true, force: true });
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
  const index = getCacheIndex();
  return Object.values(index).filter((cached) => fs.existsSync(cached.localPath));
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
