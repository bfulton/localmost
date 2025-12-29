/**
 * Workspace Snapshot and Management
 *
 * Creates temporary working directories for workflow execution,
 * respecting .gitignore and providing fast copy mechanisms.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, execSync } from 'child_process';
import { getAppDataDirWithoutElectron } from './paths';

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
  /** Additional patterns to exclude */
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
  const dir = getWorkspacesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

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
 * Uses hard links (cp -al) for speed when possible,
 * falls back to rsync for cross-filesystem copies.
 */
export async function createWorkspace(options: WorkspaceOptions): Promise<Workspace> {
  const { sourceDir, respectGitignore = true, stagedOnly = false, excludePatterns = [], includePatterns = [] } =
    options;

  ensureWorkspacesDir();

  const id = generateWorkspaceId();
  const workspacePath = path.join(getWorkspacesDir(), id);

  // Create workspace directory
  fs.mkdirSync(workspacePath, { recursive: true });

  // Build exclude patterns
  const allExcludes = [...DEFAULT_EXCLUDES, ...excludePatterns];

  if (stagedOnly) {
    // For staged-only mode, use git to create the workspace
    await createStagedWorkspace(sourceDir, workspacePath);
  } else {
    // Try hard-link copy first (fastest), fall back to rsync
    const success = await tryHardLinkCopy(sourceDir, workspacePath, allExcludes, respectGitignore);
    if (!success) {
      await rsyncCopy(sourceDir, workspacePath, allExcludes, respectGitignore);
    }
  }

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

  // Save workspace metadata
  const metadataPath = path.join(workspacePath, '.localmost-workspace.json');
  fs.writeFileSync(metadataPath, JSON.stringify(workspace, null, 2));

  return workspace;
}

/**
 * Create workspace from staged changes only.
 */
async function createStagedWorkspace(sourceDir: string, destDir: string): Promise<void> {
  // Get list of staged files
  const stagedFiles = execSync('git diff --staged --name-only', {
    cwd: sourceDir,
    encoding: 'utf-8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);

  if (stagedFiles.length === 0) {
    throw new Error('No staged changes found');
  }

  // Copy each staged file
  for (const file of stagedFiles) {
    const srcPath = path.join(sourceDir, file);
    const destPath = path.join(destDir, file);

    if (fs.existsSync(srcPath)) {
      const destFileDir = path.dirname(destPath);
      if (!fs.existsSync(destFileDir)) {
        fs.mkdirSync(destFileDir, { recursive: true });
      }
      fs.copyFileSync(srcPath, destPath);
    }
  }

  // Also copy unstaged but tracked files for context
  const trackedFiles = execSync('git ls-files', {
    cwd: sourceDir,
    encoding: 'utf-8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);

  for (const file of trackedFiles) {
    const destPath = path.join(destDir, file);
    if (!fs.existsSync(destPath)) {
      const srcPath = path.join(sourceDir, file);
      if (fs.existsSync(srcPath)) {
        const destFileDir = path.dirname(destPath);
        if (!fs.existsSync(destFileDir)) {
          fs.mkdirSync(destFileDir, { recursive: true });
        }
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

/**
 * Try to copy using hard links (cp -al on macOS/Linux).
 * Returns true if successful, false if not supported.
 */
async function tryHardLinkCopy(
  sourceDir: string,
  destDir: string,
  excludes: string[],
  respectGitignore: boolean
): Promise<boolean> {
  return new Promise((resolve) => {
    // Build rsync command with hard links
    const args = [
      '-a', // Archive mode
      '--link-dest=' + sourceDir, // Use hard links
    ];

    // Add excludes
    for (const pattern of excludes) {
      args.push('--exclude=' + pattern);
    }

    // Add gitignore support
    if (respectGitignore) {
      const gitignorePath = path.join(sourceDir, '.gitignore');
      if (fs.existsSync(gitignorePath)) {
        args.push('--exclude-from=' + gitignorePath);
      }
    }

    args.push(sourceDir + '/');
    args.push(destDir + '/');

    const proc = spawn('rsync', args, { stdio: 'ignore' });

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Copy using rsync (no hard links).
 */
async function rsyncCopy(
  sourceDir: string,
  destDir: string,
  excludes: string[],
  respectGitignore: boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-a'];

    // Add excludes
    for (const pattern of excludes) {
      args.push('--exclude=' + pattern);
    }

    // Add gitignore support
    if (respectGitignore) {
      const gitignorePath = path.join(sourceDir, '.gitignore');
      if (fs.existsSync(gitignorePath)) {
        args.push('--exclude-from=' + gitignorePath);
      }
    }

    args.push(sourceDir + '/');
    args.push(destDir + '/');

    const proc = spawn('rsync', args, { stdio: 'pipe' });

    let stderr = '';
    proc.stderr?.on('data', (data) => (stderr += data.toString()));

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`rsync failed: ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

// =============================================================================
// Workspace Cleanup
// =============================================================================

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
    const metadataPath = path.join(workspacePath, '.localmost-workspace.json');

    if (fs.existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        workspaces.push(metadata);
      } catch {
        // Invalid metadata, create from directory info
        const stats = fs.statSync(workspacePath);
        workspaces.push({
          id: entry.name,
          path: workspacePath,
          sourceDir: '',
          createdAt: stats.birthtime.toISOString(),
        });
      }
    }
  }

  // Sort by creation time, newest first
  return workspaces.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * Remove a workspace.
 */
export function removeWorkspace(id: string): boolean {
  const workspacePath = path.join(getWorkspacesDir(), id);
  if (!fs.existsSync(workspacePath)) {
    return false;
  }

  fs.rmSync(workspacePath, { recursive: true, force: true });
  return true;
}

/**
 * Clean up old workspaces.
 */
export function cleanupWorkspaces(options: WorkspaceCleanupOptions = {}): {
  removed: number;
  kept: number;
} {
  const { maxAgeHours = DEFAULT_MAX_AGE_HOURS, maxCount = DEFAULT_MAX_WORKSPACES } = options;

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
      removeWorkspace(ws.id);
      removed++;
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

    // SSH format: git@github.com:owner/repo.git
    const sshMatch = url.match(/git@github\.com:([^/]+\/[^.]+)(?:\.git)?$/);
    if (sshMatch) {
      return sshMatch[1];
    }

    // HTTPS format: https://github.com/owner/repo.git
    const httpsMatch = url.match(/https:\/\/github\.com\/([^/]+\/[^.]+)(?:\.git)?$/);
    if (httpsMatch) {
      return httpsMatch[1];
    }

    return null;
  } catch {
    return null;
  }
}
