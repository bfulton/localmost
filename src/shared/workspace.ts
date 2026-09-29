/**
 * Workspace Snapshot and Management
 *
 * Creates temporary working directories for workflow execution,
 * respecting .gitignore and providing fast copy mechanisms.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, execSync } from 'child_process';
import { getAppDataDirWithoutElectron } from './paths';
import { isValidRepository } from './policy-store';
import { REMOVAL_PREFIX, moveAsideForRemoval, removeMovedAside } from './tree-removal';

// =============================================================================
// Types
// =============================================================================

export interface WorkspaceOptions {
  /** Source directory to copy from */
  sourceDir: string;
  /** Whether to respect .gitignore (default: true) */
  respectGitignore?: boolean;
  /** Whether to only include staged changes (git diff --staged) */
  stagedOnly?: boolean;
  /** Additional names to exclude at any depth, with '*' and '?' as wildcards */
  excludePatterns?: string[];
  /** Additional patterns to include (overrides excludes) */
  includePatterns?: string[];
}

export interface Workspace {
  /** Unique workspace ID */
  id: string;
  /** Path to the workspace directory */
  path: string;
  /** Original source directory */
  sourceDir: string;
  /** Timestamp when created */
  createdAt: string;
  /** Size in bytes (approximate) */
  sizeBytes?: number;
}

export interface WorkspaceCleanupOptions {
  /** Maximum age in hours before cleanup */
  maxAgeHours?: number;
  /** Maximum number of workspaces to keep */
  maxCount?: number;
}

// =============================================================================
// Constants
// =============================================================================

const WORKSPACES_DIR = 'workspaces';
const DEFAULT_MAX_WORKSPACES = 10;
const DEFAULT_MAX_AGE_HOURS = 24;

/** Each workspace's metadata, in the workspace's top directory. */
const METADATA_FILE = '.localmost-workspace.json';

// Default patterns to always exclude
const DEFAULT_EXCLUDES = [
  '.git',
  'node_modules',
  '.localmost',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
];

// =============================================================================
// Workspace Directory Management
// =============================================================================

/**
 * Get the base workspaces directory.
 */
export function getWorkspacesDir(): string {
  return path.join(getAppDataDirWithoutElectron(), WORKSPACES_DIR);
}

/**
 * Ensure the workspaces directory exists.
 */
function ensureWorkspacesDir(): void {
  // Private to the user, whatever the shell's umask or an earlier version
  // left: a workspace is a copy of the checkout, and holds step scripts that
  // expanded ${{ secrets.X }}.
  const dir = getWorkspacesDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/**
 * The shape of a workspace ID, and so of every directory cleanup may remove.
 */
const WORKSPACE_ID = /^ws-[0-9a-z]+-[0-9a-z]+$/;

/**
 * Generate a unique workspace ID.
 */
function generateWorkspaceId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `ws-${timestamp}-${random}`;
}

// =============================================================================
// Workspace Creation
// =============================================================================

/**
 * Create a workspace snapshot from a source directory.
 *
 * The workspace is the checkout's files copied, each its own file: an APFS
 * clone where the volume can make one, which costs no space until either
 * side is written, and a byte copy where it cannot. Never a hard link - the
 * step profile grants writes on the workspace, and a hard-linked workspace
 * handed every step the checkout's own files to write.
 */
export async function createWorkspace(options: WorkspaceOptions): Promise<Workspace> {
  const { sourceDir, respectGitignore = true, stagedOnly = false, excludePatterns = [], includePatterns = [] } =
    options;

  ensureWorkspacesDir();

  const id = generateWorkspaceId();
  const workspacePath = path.join(getWorkspacesDir(), id);

  // Create workspace directory
  fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });

  // The metadata is createWorkspace's to write, not the checkout's to put
  // there: a link at its name had the write below go wherever it pointed.
  const isMetadata = (rel: string): boolean => rel === METADATA_FILE;
  if (stagedOnly) {
    // For staged-only mode, use git to create the workspace
    await createStagedWorkspace(sourceDir, workspacePath, isMetadata);
  } else {
    const matcher = excludeMatcher([...DEFAULT_EXCLUDES, ...excludePatterns]);
    const listed = respectGitignore ? listNotIgnored(sourceDir) : null;
    await copyTree(sourceDir, workspacePath, (rel) => isMetadata(rel) || matcher(rel), listed);
  }
  fs.chmodSync(workspacePath, 0o700);

  // Apply include patterns if specified
  if (includePatterns.length > 0) {
    // Re-copy included patterns that may have been excluded
    for (const pattern of includePatterns) {
      const srcPath = path.join(sourceDir, pattern);
      const destPath = path.join(workspacePath, pattern);
      if (fs.existsSync(srcPath)) {
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        fs.cpSync(srcPath, destPath, { recursive: true });
      }
    }
  }

  const workspace: Workspace = {
    id,
    path: workspacePath,
    sourceDir: path.resolve(sourceDir),
    createdAt: new Date().toISOString(),
  };

  // Save workspace metadata, as a new file: nothing may be at its name yet.
  fs.writeFileSync(path.join(workspacePath, METADATA_FILE), JSON.stringify(workspace, null, 2), { flag: 'wx' });

  return workspace;
}

/**
 * Create workspace from staged changes only: the files staged, and every
 * other tracked file for context, copied as any workspace is. Each used to
 * be copied by path, which followed a tracked link and put the contents of
 * the file of the user's it named in the workspace, for every step to read.
 */
async function createStagedWorkspace(
  sourceDir: string,
  destDir: string,
  excluded: (rel: string) => boolean
): Promise<void> {
  const git = (args: string[]): string[] =>
    execFileSync('git', args, { cwd: sourceDir, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 1024 })
      .split('\0')
      .filter(Boolean);

  const stagedFiles = git(['diff', '--staged', '--name-only', '-z']);
  if (stagedFiles.length === 0) {
    throw new Error('No staged changes found');
  }

  await copyTree(sourceDir, destDir, excluded, new Set([...stagedFiles, ...git(['ls-files', '-z'])]));
}

/**
 * A test of a checkout path - relative, with '/' between names - against
 * exclude patterns, each matched against the path's last name, as rsync's
 * --exclude matched a pattern with no '/': ".git" and "*.log" at any depth.
 * '*' and '?' match within the name.
 */
function excludeMatcher(patterns: string[]): (rel: string) => boolean {
  const names = patterns.map(
    (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\/]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  );
  return (rel) => names.some((re) => re.test(path.posix.basename(rel)));
}

/**
 * The checkout's files that git would not ignore - tracked, or untracked
 * and not ignored - relative to it.
 *
 * The ignore rules are read by git, as git reads them. They used to go to
 * rsync as --exclude-from, whose filter syntax gives the checkout's text
 * meanings git never does: a line that is only "!" cleared every rule
 * before it, the default .git exclude among them. A checkout that is not a
 * repository has its .gitignore files read by git against an empty
 * repository of its own. A listing git cannot give is an error rather than
 * a copy of everything, as an ignored file is as often a .env as a build.
 */
function listNotIgnored(sourceDir: string): Set<string> {
  const git = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: sourceDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 1024,
    });
  let listing: string;
  try {
    listing = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  } catch {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-ls-'));
    try {
      git(['init', '--quiet', '--bare', scratch]);
      listing = git([`--git-dir=${scratch}`, `--work-tree=${sourceDir}`, 'ls-files', '-z', '--others', '--exclude-standard']);
    } catch (err) {
      const reason = (err as Error).message.split('\n')[0];
      throw new Error(`Could not read the .gitignore rules of ${sourceDir} with git (${reason}); --no-ignore copies every file`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  // A repository nested in the checkout is listed as its directory, "dir/".
  return new Set(listing.split('\0').filter(Boolean).map((p) => p.replace(/\/+$/, '')));
}

/**
 * Copy a checkout into a workspace, each file its own copy.
 *
 * A regular file is cloned (COPYFILE_FICLONE: an APFS clone, or a byte copy
 * where the volume or the pair of volumes cannot clone). A link is made
 * again as a link: following it would have this unsandboxed process copy
 * whatever it names into the workspace. Anything else - a FIFO, a socket -
 * is left out, as opening a FIFO waits for a writer. With a listing, only
 * what it names is copied, and a directory it names is copied whole.
 */
async function copyTree(
  sourceDir: string,
  destDir: string,
  excluded: (rel: string) => boolean,
  listed: Set<string> | null
): Promise<void> {
  // Every directory some listed path is in, which the walk has to enter.
  const within = new Set<string>();
  for (const file of listed ?? []) {
    for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) within.add(dir);
  }

  const files: string[] = [];
  const dirs: Array<{ rel: string; mode: number }> = [];
  const walk = async (rel: string, whole: boolean): Promise<void> => {
    for (const entry of await fs.promises.readdir(path.join(sourceDir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (excluded(child)) continue;
      const wanted = whole || listed === null || listed.has(child);
      if (entry.isDirectory()) {
        if (!wanted && !within.has(child)) continue;
        const { mode } = await fs.promises.lstat(path.join(sourceDir, child));
        await fs.promises.mkdir(path.join(destDir, child), { mode: 0o700 });
        dirs.push({ rel: child, mode });
        await walk(child, wanted);
      } else if (wanted && entry.isSymbolicLink()) {
        await fs.promises.symlink(await fs.promises.readlink(path.join(sourceDir, child)), path.join(destDir, child));
      } else if (wanted && entry.isFile()) {
        files.push(child);
      }
    }
  };
  await walk('', false);

  let next = 0;
  const copier = async (): Promise<void> => {
    while (next < files.length) {
      const rel = files[next++];
      await fs.promises.copyFile(
        path.join(sourceDir, rel),
        path.join(destDir, rel),
        fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE
      );
    }
  };
  await Promise.all(Array.from({ length: 16 }, copier));

  // Each directory takes the checkout's mode once it is filled, always with
  // the owner's bits, which removing the workspace needs.
  for (const { rel, mode } of dirs.reverse()) {
    await fs.promises.chmod(path.join(destDir, rel), (mode & 0o777) | 0o700);
  }
}

// =============================================================================
// Workspace Cleanup
// =============================================================================

/** Far more than createWorkspace writes: a metadata file is a few lines. */
const METADATA_MAX_BYTES = 64 * 1024;

/**
 * Read a workspace's metadata file, or nothing if it is not one
 * createWorkspace could have written.
 *
 * The run's steps can replace the file. A FIFO put there had every later
 * run's cleanup wait in open() for a writer that never came, and a link to
 * one, or to a device, did the same or read without end. Opened without
 * following a symlink or waiting on a FIFO, as readStepOutputs opens a
 * step's output file, and read only if it is a small regular file with no
 * other name.
 */
function readWorkspaceMetadata(metadataPath: string): Record<string, unknown> | null {
  let fd: number;
  try {
    fd = fs.openSync(metadataPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > METADATA_MAX_BYTES) return null;
    const metadata: unknown = JSON.parse(fs.readFileSync(fd, 'utf-8'));
    return metadata !== null && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * List all workspaces.
 */
export function listWorkspaces(): Workspace[] {
  const dir = getWorkspacesDir();
  if (!fs.existsSync(dir)) {
    return [];
  }

  const workspaces: Workspace[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('ws-')) {
      continue;
    }

    const workspacePath = path.join(dir, entry.name);
    // The metadata lives in the workspace, which the run's steps can write,
    // so it supplies nothing that names a directory: the id and path are the
    // directory's own. A step that rewrote its id to "../.." had cleanup
    // delete whatever that pointed at. Without metadata that can be read,
    // the workspace is dated by its directory.
    const metadata = readWorkspaceMetadata(path.join(workspacePath, METADATA_FILE));
    const createdAt = new Date(typeof metadata?.createdAt === 'string' ? metadata.createdAt : NaN);
    workspaces.push({
      id: entry.name,
      path: workspacePath,
      sourceDir: typeof metadata?.sourceDir === 'string' ? metadata.sourceDir : '',
      createdAt: isNaN(createdAt.getTime())
        ? fs.statSync(workspacePath).birthtime.toISOString()
        : createdAt.toISOString(),
    });
  }

  // Sort by creation time, newest first
  return workspaces.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * Remove a workspace, as a runner job's sandbox is removed.
 *
 * Something of the run may still write it: a step process that outlived the
 * reap keeps a profile granting the workspace's path, and a container a step
 * started writes it through Docker's file sharing under no profile. A walk
 * by path loses to either - it finds a directory, the writer swaps it for a
 * link, and the walk deletes what the link points to. So the workspace is
 * first moved beside itself under a name no step's profile grants (the
 * workspaces directory is app data, which every profile denies but for the
 * run's own workspace), then removed without following a link anywhere in
 * it (see moveAsideForRemoval and removeMovedAside). Resolves to whether
 * there was a workspace to remove; rejects when there was, but it could not
 * all be removed, and cleanupWorkspaces finishes it later.
 */
export async function removeWorkspace(id: string): Promise<boolean> {
  // Only ever a workspace directory itself: an id that is not one could name
  // anything path.join resolves it to.
  if (!WORKSPACE_ID.test(id)) {
    return false;
  }
  const aside = await moveAsideForRemoval(path.join(getWorkspacesDir(), id));
  if (!aside) {
    return false;
  }
  await removeMovedAside(aside);
  return true;
}

/**
 * Clean up old workspaces, and finish any removal an earlier cleanup left
 * part done. A workspace counts as removed once all of it is gone; each one
 * that is not is named in a warning on stderr.
 */
export async function cleanupWorkspaces(options: WorkspaceCleanupOptions = {}): Promise<{
  removed: number;
  kept: number;
}> {
  const { maxAgeHours = DEFAULT_MAX_AGE_HOURS, maxCount = DEFAULT_MAX_WORKSPACES } = options;

  let leftovers: fs.Dirent[] = [];
  try {
    leftovers = await fs.promises.readdir(getWorkspacesDir(), { withFileTypes: true });
  } catch {
    // No workspaces directory yet.
  }
  for (const entry of leftovers) {
    if (!entry.name.startsWith(REMOVAL_PREFIX)) continue;
    await removeMovedAside(path.join(getWorkspacesDir(), entry.name)).catch((err) => {
      console.error(`Warning: could not finish removing ${entry.name}: ${(err as Error).message}`);
    });
  }

  const workspaces = listWorkspaces();
  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

  let removed = 0;
  let kept = 0;

  for (let i = 0; i < workspaces.length; i++) {
    const ws = workspaces[i];
    const age = now - new Date(ws.createdAt).getTime();

    // Remove if too old or exceeds max count
    if (age > maxAgeMs || i >= maxCount) {
      // What a failed removal leaves is out of every step's reach, and the
      // next cleanup tries it again.
      try {
        if (await removeWorkspace(ws.id)) removed++;
      } catch (err) {
        console.error(`Warning: could not remove old workspace ${ws.id}: ${(err as Error).message}`);
      }
    } else {
      kept++;
    }
  }

  return { removed, kept };
}

/**
 * Get total size of all workspaces in bytes.
 */
export function getWorkspacesTotalSize(): number {
  const dir = getWorkspacesDir();
  if (!fs.existsSync(dir)) {
    return 0;
  }

  function getDirSize(dirPath: string): number {
    let size = 0;
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
      const filePath = path.join(dirPath, file.name);
      if (file.isDirectory()) {
        size += getDirSize(filePath);
      } else {
        try {
          size += fs.statSync(filePath).size;
        } catch {
          // Ignore errors (e.g., permission denied)
        }
      }
    }
    return size;
  }

  return getDirSize(dir);
}

// =============================================================================
// Git Integration
// =============================================================================

/**
 * Get git info from a directory.
 */
export function getGitInfo(dir: string): {
  sha: string;
  ref: string;
  dirty: boolean;
  branch?: string;
} | null {
  try {
    const sha = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
    const ref = execSync('git symbolic-ref HEAD 2>/dev/null || git rev-parse HEAD', {
      cwd: dir,
      encoding: 'utf-8',
    }).trim();
    const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf-8' }).trim();
    const dirty = status.length > 0;
    const branch = ref.startsWith('refs/heads/') ? ref.replace('refs/heads/', '') : undefined;

    return { sha, ref, dirty, branch };
  } catch {
    return null;
  }
}

/**
 * Check if a directory is a git repository.
 */
export function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/**
 * Parse a repository identifier from a directory path (via git remote origin).
 * Returns "owner/repo" format or null if not a git repo.
 */
export function getRepositoryFromDir(dir: string): string | null {
  try {
    const result = execSync('git remote get-url origin', {
      cwd: dir,
      encoding: 'utf-8',
    });

    const url = result.trim();

    // git@github.com:owner/repo.git, ssh://git@github.com/owner/repo.git or
    // https://github.com/owner/repo.git, with or without the suffix. A repo
    // name may itself contain dots - "[^.]+" used to stop at the first one and
    // then fail to match, so "owner/my.repo" had no repository at all.
    const match = url.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)(.+?)(?:\.git)?\/?$/);
    // Held to GitHub's own name grammar: the policy approval cache is keyed
    // on this, and anything else is not a repository it could hold.
    return match && isValidRepository(match[1]) ? match[1] : null;
  } catch {
    return null;
  }
}
