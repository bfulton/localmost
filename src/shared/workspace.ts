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

/**
 * The directories the app hands every step, in the workspace's top
 * directory and never copied from the checkout: its HOME and its TMPDIR
 * (see createStepHome in step-executor).
 */
const STEP_DIRS = ['.home', '.tmp'];

/** A name as the default APFS volume compares it: in any case, and any Unicode form. */
const folded = (name: string): string => name.normalize('NFD').toUpperCase().toLowerCase();

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
 * The shape of a workspace ID, and so of every directory cleanup may remove:
 * the time it was made, in milliseconds, then a random part, both base 36.
 */
const WORKSPACE_ID = /^ws-([0-9a-z]+)-[0-9a-z]+$/;

/**
 * Generate a unique workspace ID, which dates the workspace.
 */
function generateWorkspaceId(now: number): string {
  const timestamp = now.toString(36);
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
  const { sourceDir, respectGitignore = true, stagedOnly = false, excludePatterns = [] } = options;

  ensureWorkspacesDir();

  const now = Date.now();
  const id = generateWorkspaceId(now);
  const workspacePath = path.join(getWorkspacesDir(), id);

  // Create workspace directory
  fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });

  const workspace: Workspace = {
    id,
    path: workspacePath,
    sourceDir: path.resolve(sourceDir),
    createdAt: new Date(now).toISOString(),
  };

  // The metadata is createWorkspace's to write, not the checkout's to put
  // there, so it is written first, as a new file, into the empty workspace:
  // nothing may be at its name yet, and 'wx' refuses a link or file already
  // there in a directory left at this id, which mkdir reuses. The copy then
  // finds the name taken by any checkout entry the volume takes for it -
  // ".LOCALMOST-WORKSPACE.JSON", or one with a long s for the s, which the
  // exclude by exact name misses - and skips that entry. Written after the
  // copy, such an entry failed the run, and a link there had the write go
  // wherever it pointed.
  fs.writeFileSync(path.join(workspacePath, METADATA_FILE), JSON.stringify(workspace, null, 2), { flag: 'wx' });

  // The steps' home and temp are the app's to make, so the checkout's
  // entries at their names - in any case the volume takes for them - are
  // left out: `localmost test` fills the home unsandboxed before the first
  // step, and a committed `.home` link had it write the git and ssh config
  // wherever the link led. Only at the top: a `.home` deeper in is the
  // checkout's own.
  const isStepDir = (rel: string): boolean => STEP_DIRS.some((name) => folded(rel) === folded(name));

  const isMetadata = (rel: string): boolean => rel === METADATA_FILE || isStepDir(rel);
  if (stagedOnly) {
    // For staged-only mode, use git to create the workspace
    await createStagedWorkspace(sourceDir, workspacePath, isMetadata);
  } else {
    const matcher = excludeMatcher([...DEFAULT_EXCLUDES, ...excludePatterns]);
    const listed = respectGitignore ? listNotIgnored(sourceDir) : null;
    await copyTree(sourceDir, workspacePath, (rel) => isMetadata(rel) || matcher(rel), listed);
  }
  fs.chmodSync(workspacePath, 0o700);

  return workspace;
}

/**
 * Create workspace from staged changes only: the files staged, and every
 * other tracked file for context, copied as any workspace is. Each used to
 * be copied by path, which followed a tracked link and put the contents of
 * the file of the user's it named in the workspace, for every step to read.
 * A submodule is its directory, empty, as a checkout without submodules
 * leaves it, and no .git is copied from anywhere.
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

  await copyTree(
    sourceDir,
    destDir,
    (rel) => excluded(rel) || path.posix.basename(rel) === '.git',
    [...new Set([...stagedFiles, ...git(['ls-files', '-z'])])]
  );
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
 * and not ignored - relative to it, with '/' between names.
 *
 * The ignore rules are read by git, as git reads them. They used to go to
 * rsync as --exclude-from, whose filter syntax gives the checkout's text
 * meanings git never does: a line that is only "!" cleared every rule
 * before it, the default .git exclude among them. They are the rules of the
 * repository the checkout is; one that is not a repository, or that lies in
 * a repository which ignores it (a home directory kept as a dotfiles
 * repository that ignores everything, say), has its .gitignore files read by
 * git against an empty repository of its own. A repository within it - a
 * submodule, or one nested untracked - is listed by its own rules and then
 * held to the checkout's too, where it used to be copied whole, whatever
 * either ignored. A listing git cannot give is an error rather than a copy
 * of everything, as an ignored file is as often a .env as a build.
 */
function listNotIgnored(sourceDir: string): string[] {
  const run = (args: string[], input?: string): string =>
    execFileSync('git', args, {
      cwd: sourceDir,
      encoding: 'utf-8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 1024,
    });
  const names = (output: string): string[] => output.split('\0').filter(Boolean);
  // check-ignore exits 1 when it ignores none of the paths it is given.
  const exitedWith = (err: unknown, status: number): boolean => (err as { status?: unknown }).status === status;

  // Whether git reads sourceDir's rules from a repository: one it is the top
  // of, or one it is in and not ignored by.
  const inRepository = (): boolean => {
    let prefix: string;
    try {
      prefix = run(['rev-parse', '--show-prefix']).trim();
    } catch {
      return false;
    }
    if (prefix === '') return true;
    try {
      run(['check-ignore', '-q', '--no-index', './']);
      return false;
    } catch (err) {
      return exitedWith(err, 1);
    }
  };

  // A directory, not a link to one elsewhere, that git would take for a
  // repository of its own.
  const isRepository = (dir: string): boolean => {
    try {
      return fs.lstatSync(dir).isDirectory() && fs.existsSync(path.join(dir, '.git'));
    } catch {
      return false;
    }
  };

  let scratch: string | null = null;
  try {
    let git = run;
    if (!inRepository()) {
      const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-ls-'));
      scratch = gitDir;
      run(['init', '--quiet', '--bare', gitDir]);
      git = (args, input) => run([`--git-dir=${gitDir}`, `--work-tree=${sourceDir}`, ...args], input);
    }

    const listed: string[] = [];
    const nested: string[] = [];
    for (const name of names(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']))) {
      // A repository within the checkout is listed as its directory, as
      // "dir/" when it is untracked. The directory itself is kept, to be
      // made empty when nothing in it is listed.
      const rel = name.replace(/\/+$/, '');
      listed.push(rel);
      if (isRepository(path.join(sourceDir, rel))) {
        nested.push(...listNotIgnored(path.join(sourceDir, rel)).map((inner) => `${rel}/${inner}`));
      }
    }
    if (nested.length > 0) {
      let ignored: Set<string>;
      try {
        ignored = new Set(names(git(['check-ignore', '-z', '--stdin', '--no-index'], nested.join('\0'))));
      } catch (err) {
        if (!exitedWith(err, 1)) throw err;
        ignored = new Set();
      }
      listed.push(...nested.filter((rel) => !ignored.has(rel)));
    }
    return listed;
  } catch (err) {
    const reason = (err as Error).message.split('\n')[0];
    throw new Error(`Could not read the .gitignore rules of ${sourceDir} with git (${reason}); --no-ignore copies every file`);
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Copy a checkout into a workspace, each file its own copy: the paths
 * listed, or without a listing every path in the checkout, less those
 * excluded, which take all that is in them out too.
 *
 * A regular file is cloned (COPYFILE_FICLONE: an APFS clone, or a byte copy
 * where the volume or the pair of volumes cannot clone). A link is made
 * again as a link: following it would have this unsandboxed process copy
 * whatever it names into the workspace. Anything else - a FIFO, a socket -
 * is left out, as opening a FIFO waits for a writer. A listed directory is
 * made, holding only what else is listed in it: a directory git lists is a
 * submodule, a repository nested untracked, or a tracked file since
 * replaced by a directory, and was once copied whole, ignored files and all.
 *
 * Each listed path is looked up by the name git gives it, as the volume
 * resolves that name, never matched to the names a walk of the checkout
 * finds: git gives names precomposed and in the case its index holds, where
 * the volume can hold them decomposed or renamed in case, and those files
 * were left out.
 */
async function copyTree(
  sourceDir: string,
  destDir: string,
  excluded: (rel: string) => boolean,
  listed: string[] | null
): Promise<void> {
  const walk = async (rel: string, into: string[]): Promise<string[]> => {
    for (const entry of await fs.promises.readdir(path.join(sourceDir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (excluded(child)) continue;
      into.push(child);
      if (entry.isDirectory()) await walk(child, into);
    }
    return into;
  };
  const paths = listed ?? (await walk('', []));

  // Each directory, made in the workspace once, if it is a directory in the
  // checkout, not a link to one, and not excluded, nor in one that is.
  const modes: Array<{ rel: string; mode: number }> = [];
  const made = new Map<string, Promise<boolean>>([['.', Promise.resolve(true)]]);
  const makeDir = (rel: string): Promise<boolean> => {
    let making = made.get(rel);
    if (!making) {
      making = (async () => {
        if (!(await makeDir(path.posix.dirname(rel))) || excluded(rel)) return false;
        const stat = await fs.promises.lstat(path.join(sourceDir, rel)).catch(() => null);
        if (!stat?.isDirectory()) return false;
        try {
          await fs.promises.mkdir(path.join(destDir, rel), { mode: 0o700 });
        } catch (err) {
          // Two names the checkout's volume tells apart and the workspace's
          // does not, or a name taken by the workspace's metadata, written
          // before the copy (see createWorkspace): the first made stands,
          // and only if it is a directory.
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          return (await fs.promises.lstat(path.join(destDir, rel))).isDirectory();
        }
        modes.push({ rel, mode: stat.mode });
        return true;
      })();
      made.set(rel, making);
    }
    return making;
  };

  const place = async (rel: string): Promise<void> => {
    if (!(await makeDir(path.posix.dirname(rel))) || excluded(rel)) return;
    const from = path.join(sourceDir, rel);
    const to = path.join(destDir, rel);
    // Listed and since removed from the working tree: nothing to copy.
    const stat = await fs.promises.lstat(from).catch(() => null);
    try {
      if (stat?.isDirectory()) {
        await makeDir(rel);
      } else if (stat?.isSymbolicLink()) {
        await fs.promises.symlink(await fs.promises.readlink(from), to);
      } else if (stat?.isFile()) {
        await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
      }
    } catch (err) {
      // Listed twice, by names the workspace's volume does not tell apart,
      // or taken by the workspace's metadata, written before the copy (see
      // createWorkspace): the first one made stands, never overwritten.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  };

  let next = 0;
  const copier = async (): Promise<void> => {
    while (next < paths.length) await place(paths[next++]);
  };
  await Promise.all(Array.from({ length: 16 }, copier));

  // Each directory takes the checkout's mode once it is filled, always with
  // the owner's bits, which removing the workspace needs.
  for (const { rel, mode } of modes) {
    await fs.promises.chmod(path.join(destDir, rel), (mode & 0o777) | 0o700);
  }
}

// =============================================================================
// Workspace Cleanup
// =============================================================================

/**
 * List all workspaces, newest first.
 *
 * Each is known by its directory alone, dated by the time in its name. Its
 * metadata lives in the workspace, which the run's steps can write, and is
 * not read: a step that rewrote the id in it to "../.." had cleanup delete
 * whatever that pointed at; one that dated it years ahead, or removed it,
 * kept its workspace from ever being removed; and one that put a FIFO there
 * had every later run wait in open() for a writer. A step cannot rename its
 * workspace, as the directory it is in is app data, which it cannot write.
 */
export function listWorkspaces(): Array<Omit<Workspace, 'sourceDir'>> {
  const dir = getWorkspacesDir();
  if (!fs.existsSync(dir)) {
    return [];
  }

  const workspaces: Array<Omit<Workspace, 'sourceDir'>> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const made = WORKSPACE_ID.exec(entry.name);
    if (!entry.isDirectory() || !made) {
      continue;
    }
    // A name no clock of createWorkspace's gave counts as the oldest.
    const at = new Date(parseInt(made[1], 36));
    workspaces.push({
      id: entry.name,
      path: path.join(dir, entry.name),
      createdAt: (isNaN(at.getTime()) ? new Date(0) : at).toISOString(),
    });
  }

  return workspaces.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
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
