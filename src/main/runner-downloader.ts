import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createWriteStream, createReadStream } from 'fs';
import * as tar from 'tar';
import { FALLBACK_RUNNER_VERSION } from '../shared/constants';
import { spawnSandboxed } from './process-sandbox';
import { getRunnerDir } from './paths';
import {
  killOrphanedProcesses,
  cleanupSandboxDirectories,
  cleanupIncompleteConfigs,
  cleanupWorkDirectories as cleanupWorkDirs,
} from './runner-cleanup';

export interface DownloadProgress {
  phase: 'downloading' | 'extracting' | 'complete' | 'error';
  percent: number;
  message: string;
}

export type ProgressCallback = (progress: DownloadProgress) => void;

/** The only files buildSandbox takes from an instance's config directory. */
const SANDBOX_CONFIG_FILES = ['.runner'];

/**
 * What a runner template held when it came from its release: each file's
 * sha256 and each symlink's target, by path relative to the template.
 */
interface ArcManifest {
  files: Map<string, string>;
  symlinks: Map<string, string>;
}

/** Run fn over items, at most limit at a time. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(lanes);
  return results;
}

export interface RunnerRelease {
  version: string;
  url: string;
  publishedAt: string;
}

/**
 * Directory structure:
 * ~/.localmost/runner/
 *   arc/v2.330.0/     - downloaded binaries (versioned, persistent)
 *   config/1/         - config files for instance 1 (persistent)
 *   sandbox/1/        - ephemeral sandbox for instance 1 (rebuilt on each start)
 */
export class RunnerDownloader {
  private readonly baseDir: string;
  private readonly fallbackVersion = FALLBACK_RUNNER_VERSION;
  private selectedVersion: string | null = null;
  /** Records being built from a release download, so concurrent starts share one. */
  private manifestsInFlight: Map<string, Promise<ArcManifest>> = new Map();

  constructor() {
    this.baseDir = getRunnerDir();
  }

  /** Get the arc directory for a specific version */
  getArcDir(version: string): string {
    return path.join(this.baseDir, 'arc', `v${version}`);
  }

  /** Get the config directory for a specific instance */
  getConfigDir(instance: number): string {
    return path.join(this.baseDir, 'config', `${instance}`);
  }

  /** Get the sandbox directory for a specific instance */
  getSandboxDir(instance: number): string {
    return path.join(this.baseDir, 'sandbox', `${instance}`);
  }

  /** Get the base runner directory */
  getBaseDir(): string {
    return this.baseDir;
  }

  /** Get the persistent tool cache directory (shared across all instances) */
  getToolCacheDir(): string {
    return path.join(this.baseDir, 'tool-cache');
  }

  /**
   * Where a version's integrity record lives: beside arc/, not in it, so a
   * version directory holds exactly what its release did.
   */
  getArcManifestPath(version: string): string {
    return path.join(this.baseDir, 'arc-manifests', `v${version}.json`);
  }

  /**
   * Recursively copy a directory.
   * @param src Source directory path
   * @param dest Destination directory path
   * @param sandboxRoot Root directory for symlink validation (defaults to dest on first call)
   */
  private async copyDir(src: string, dest: string, sandboxRoot?: string): Promise<void> {
    // On first call, sandboxRoot is the destination directory
    const root = sandboxRoot ?? dest;

    try {
      await fs.promises.mkdir(dest, { recursive: true });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      throw new Error(`mkdir failed for ${dest}: ${e.code} ${e.message} (syscall: ${e.syscall})`);
    }

    const entries = await fs.promises.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDir(srcPath, destPath, root);
      } else if (entry.isSymbolicLink()) {
        const linkTarget = await fs.promises.readlink(srcPath);

        // Security: Validate symlink target stays within sandbox
        // Reject absolute symlinks - they could point anywhere
        if (path.isAbsolute(linkTarget)) {
          throw new Error(
            `Security violation: Absolute symlink not allowed: ${srcPath} -> ${linkTarget}`
          );
        }

        // Resolve the symlink target relative to the destination directory
        const destDir = path.dirname(destPath);
        const resolvedTarget = path.normalize(path.join(destDir, linkTarget));

        // Verify the resolved path stays within the sandbox root
        const normalizedRoot = path.normalize(root) + path.sep;
        if (!resolvedTarget.startsWith(normalizedRoot) && resolvedTarget !== path.normalize(root)) {
          throw new Error(
            `Security violation: Symlink escapes sandbox: ${srcPath} -> ${linkTarget} (resolves to ${resolvedTarget})`
          );
        }

        // Remove existing file/symlink at destination if present
        try {
          await fs.promises.unlink(destPath);
        } catch (unlinkErr) {
          // Expected: file doesn't exist yet. Unexpected: permission error
          const code = (unlinkErr as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') {
            throw new Error(`Failed to remove existing file at ${destPath}: ${code}`);
          }
        }
        await fs.promises.symlink(linkTarget, destPath);
      } else {
        // Use lstat to check what we're dealing with before copying
        let srcStats;
        try {
          srcStats = fs.lstatSync(srcPath);
        } catch (lstatErr) {
          // Source doesn't exist (broken symlink in directory listing?) - skip
          // This is expected for dangling symlinks, so we only log unexpected errors
          const code = (lstatErr as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') {
            throw new Error(`Failed to stat ${srcPath}: ${code}`);
          }
          continue;
        }
        if (!srcStats.isFile()) {
          // Skip non-regular files (sockets, FIFOs, etc.)
          continue;
        }
        // Ensure parent directory exists (belt-and-suspenders safety)
        const destParent = path.dirname(destPath);
        if (!fs.existsSync(destParent)) {
          fs.mkdirSync(destParent, { recursive: true });
        }
        try {
          fs.copyFileSync(srcPath, destPath);
          if (srcStats.mode & 0o111) {
            fs.chmodSync(destPath, srcStats.mode);
          }
        } catch (copyErr) {
          const e = copyErr as NodeJS.ErrnoException;
          throw new Error(`copyfile '${srcPath}' -> '${destPath}': ${e.code} ${e.message}`);
        }
      }
    }
  }

  /**
   * Copy a version's runner template to dest, then check the copy against the
   * template's integrity record, and throw if they differ.
   *
   * Every worker runs a copy of arc/, so something that could write there once
   * would reach every later job; and registration runs it unsandboxed. The
   * copy is what gets checked, not the template, so nothing can change between
   * the check and the run. A version with no record yet - installed before
   * records were kept - gets one built from its release download, checked
   * against GitHub's published checksum. Recording what is on disk instead
   * would bless a template already changed.
   */
  async copyVerifiedArc(
    version: string,
    dest: string,
    onLog?: (level: 'info' | 'error', message: string) => void
  ): Promise<void> {
    const log = onLog || (() => {});
    const arcDir = this.getArcDir(version);
    const manifest = await this.ensureArcManifest(version, log);
    await this.copyDir(arcDir, dest);

    const differences = await this.compareWithManifest(dest, manifest);
    if (differences.length > 0) {
      log('error', `Runner v${version} in ${arcDir} does not match the release it was installed from; no runner will start from it. Delete that directory and restart localmost to install the runner again.`);
      for (const difference of differences.slice(0, 20)) {
        log('error', `  ${difference}`);
      }
      if (differences.length > 20) {
        log('error', `  ...and ${differences.length - 20} more`);
      }
      const more = differences.length > 1 ? `, and ${differences.length - 1} more` : '';
      throw new Error(`Runner v${version} does not match its integrity record (${differences[0]}${more})`);
    }
  }

  /** Record what a version's template holds now. Called as it is extracted. */
  async recordArcManifest(version: string): Promise<void> {
    await this.writeArcManifest(version, await this.manifestOf(this.getArcDir(version)));
  }

  private async ensureArcManifest(
    version: string,
    log: (level: 'info' | 'error', message: string) => void
  ): Promise<ArcManifest> {
    const recorded = this.readArcManifest(version);
    if (recorded) return recorded;

    let pending = this.manifestsInFlight.get(version);
    if (!pending) {
      log('info', `No integrity record for runner v${version}; building one from its release download...`);
      pending = this.manifestFromRelease(version).finally(() => this.manifestsInFlight.delete(version));
      this.manifestsInFlight.set(version, pending);
    }
    return pending;
  }

  /**
   * Download a version's release, check it against its published checksum,
   * and record what it holds. The download is extracted to a scratch directory
   * that is removed afterwards; the installed template is not touched.
   */
  private async manifestFromRelease(version: string): Promise<ArcManifest> {
    const { filename, url } = this.releaseAsset(version);
    const scratch = await fs.promises.mkdtemp(path.join(this.baseDir, 'arc-verify-'));
    try {
      const expectedChecksum = await this.fetchExpectedChecksum(version, filename);
      const tarballPath = path.join(scratch, filename);
      await this.downloadFile(url, tarballPath, () => {});
      await this.verifyChecksum(tarballPath, expectedChecksum);

      const tree = path.join(scratch, 'tree');
      await fs.promises.mkdir(tree);
      await tar.extract({ file: tarballPath, cwd: tree, preserveOwner: false });

      const manifest = await this.manifestOf(tree);
      await this.writeArcManifest(version, manifest);
      return manifest;
    } finally {
      await fs.promises.rm(scratch, { recursive: true, force: true });
    }
  }

  /** A version's record, or undefined if there is none or it cannot be read. */
  private readArcManifest(version: string): ArcManifest | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.getArcManifestPath(version), 'utf-8'));
      const files = Object.entries(parsed?.files ?? {});
      const symlinks = Object.entries(parsed?.symlinks ?? {});
      const wellFormed = files.length > 0 &&
        files.every(([, hash]) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)) &&
        symlinks.every(([, target]) => typeof target === 'string');
      if (!wellFormed) return undefined;
      return {
        files: new Map(files as Array<[string, string]>),
        symlinks: new Map(symlinks as Array<[string, string]>),
      };
    } catch {
      return undefined;
    }
  }

  private async writeArcManifest(version: string, manifest: ArcManifest): Promise<void> {
    const file = this.getArcManifestPath(version);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const sorted = (entries: Map<string, string>) =>
      Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : 1)));
    // Written aside and renamed in, so a record is never read half-written.
    const staging = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(
      staging,
      JSON.stringify({ files: sorted(manifest.files), symlinks: sorted(manifest.symlinks) }),
      { mode: 0o600 }
    );
    await fs.promises.rename(staging, file);
  }

  /** The files and symlinks under a directory, by relative path. copyDir copies nothing else. */
  private async listTree(root: string): Promise<{ files: string[]; symlinks: string[] }> {
    const files: string[] = [];
    const symlinks: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      const entries = await fs.promises.readdir(path.join(root, relative), { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(entryPath);
        else if (entry.isSymbolicLink()) symlinks.push(entryPath);
        else if (entry.isFile()) files.push(entryPath);
      }
    };
    await walk('');
    return { files, symlinks };
  }

  private async manifestOf(root: string): Promise<ArcManifest> {
    const { files, symlinks } = await this.listTree(root);
    const hashes = await mapWithLimit(files, 16, (file) => this.computeFileChecksum(path.join(root, file)));
    const targets = await Promise.all(symlinks.map((link) => fs.promises.readlink(path.join(root, link))));
    return {
      files: new Map(files.map((file, i) => [file, hashes[i]])),
      symlinks: new Map(symlinks.map((link, i) => [link, targets[i]])),
    };
  }

  /** How a directory differs from a record: every file added, missing or changed. */
  private async compareWithManifest(root: string, manifest: ArcManifest): Promise<string[]> {
    const actual = await this.manifestOf(root);
    const differences: string[] = [];
    for (const [file, hash] of actual.files) {
      const expected = manifest.files.get(file);
      if (expected === undefined) differences.push(`added: ${file}`);
      else if (expected !== hash) differences.push(`changed: ${file}`);
    }
    for (const [link, target] of actual.symlinks) {
      const expected = manifest.symlinks.get(link);
      if (expected === undefined) differences.push(`added: ${link} -> ${target}`);
      else if (expected !== target) differences.push(`changed: ${link} -> ${target} (was ${expected})`);
    }
    for (const file of manifest.files.keys()) {
      if (!actual.files.has(file)) differences.push(`missing: ${file}`);
    }
    for (const link of manifest.symlinks.keys()) {
      if (!actual.symlinks.has(link)) differences.push(`missing: ${link}`);
    }
    return differences;
  }

  /**
   * Get the path for preserved work directory (outside sandbox).
   */
  getWorkDir(instance: number): string {
    return path.join(this.baseDir, 'work', String(instance));
  }

  /**
   * Build a sandbox for the given instance by copying arc + config.
   * This should be called before starting each runner instance.
   */
  async buildSandbox(
    instance: number,
    version: string,
    onLog?: (level: 'info' | 'error', message: string) => void,
    options?: { preserveWorkDir?: boolean }
  ): Promise<string> {
    const log = onLog || (() => {});
    const arcDir = this.getArcDir(version);
    const configDir = this.getConfigDir(instance);
    const sandboxDir = this.getSandboxDir(instance);
    const preserveWorkDir = options?.preserveWorkDir ?? false;

    if (!fs.existsSync(arcDir)) {
      throw new Error(`Runner version ${version} not downloaded. Please download first.`);
    }

    // Remove existing sandbox via rename + background delete (fast and reliable)
    if (fs.existsSync(sandboxDir)) {
      const trashDir = `${sandboxDir}.trash.${Date.now()}`;
      try {
        fs.renameSync(sandboxDir, trashDir);
        log('info', `Moved sandbox to trash for background cleanup`);
        // Delete in background (fire and forget)
        fs.promises.rm(trashDir, { recursive: true, force: true }).catch(() => {
          // Background cleanup - failures are non-fatal, will retry on next startup
          // Common causes: file in use, permissions, concurrent access
        });
      } catch (renameErr) {
        log('error', `Could not rename sandbox: ${(renameErr as Error).message}`);
        throw new Error(`Failed to clean sandbox for instance ${instance}: ${(renameErr as Error).message}`);
      }
    }

    // Verify sandbox directory is gone (should always be true after sync rm or rename)
    if (fs.existsSync(sandboxDir)) {
      log('error', `Sandbox still exists after cleanup: ${sandboxDir}`);
      throw new Error(`Failed to clean sandbox for instance ${instance}: directory still exists`);
    }

    // Copy arc to sandbox
    log('info', `Copying arc to sandbox...`);
    const copyStart = Date.now();
    await this.copyVerifiedArc(version, sandboxDir, log);
    log('info', `Arc copy completed in ${Date.now() - copyStart}ms`);

    // Verify critical files exist
    const criticalFiles = ['run.sh', 'bin/Runner.Listener'];
    for (const file of criticalFiles) {
      const filePath = path.join(sandboxDir, file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Critical file missing after copy: ${file}`);
      }
    }

    // Copy the runner's settings into the sandbox - and only those. The job
    // can read its sandbox, so the registration's key (.credentials_rsaparams)
    // and .credentials never go in, even when a legacy registration or an
    // earlier version left them in the config dir. The worker is given a key
    // made for its start by startInstance instead.
    for (const file of SANDBOX_CONFIG_FILES) {
      const srcPath = path.join(configDir, file);
      if (fs.existsSync(srcPath) && (await fs.promises.stat(srcPath)).isFile()) {
        await fs.promises.copyFile(srcPath, path.join(sandboxDir, file));
      }
    }

    // Set up preserved work directory if enabled
    if (preserveWorkDir) {
      const workDir = this.getWorkDir(instance);
      const sandboxWorkDir = path.join(sandboxDir, '_work');

      // Ensure preserved work directory exists
      await fs.promises.mkdir(workDir, { recursive: true });

      // Create symlink from sandbox/_work -> preserved work dir
      try {
        await fs.promises.symlink(workDir, sandboxWorkDir);
        log('info', `Linked _work to preserved directory`);
      } catch (symlinkErr) {
        log('error', `Failed to create work dir symlink: ${(symlinkErr as Error).message}`);
        // Non-fatal - runner will create _work directory normally
      }
    }

    return sandboxDir;
  }

  /**
   * Save config files from sandbox to persistent config directory.
   * Should be called after configuration completes.
   */
  async saveConfig(instance: number): Promise<void> {
    const sandboxDir = this.getSandboxDir(instance);
    const configDir = this.getConfigDir(instance);

    const configFiles = ['.runner', '.credentials', '.credentials_rsaparams'];

    // Create config directory
    await fs.promises.mkdir(configDir, { recursive: true });

    // Copy config files from sandbox to config dir
    for (const file of configFiles) {
      const srcPath = path.join(sandboxDir, file);
      const destPath = path.join(configDir, file);
      if (fs.existsSync(srcPath)) {
        await fs.promises.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Clear config files for an instance.
   * Used before re-registration when the GitHub registration is gone.
   */
  async clearConfig(
    instance: number,
    onLog?: (level: 'info' | 'error', message: string) => void
  ): Promise<void> {
    const log = onLog || (() => {});
    const configDir = this.getConfigDir(instance);
    const configFiles = ['.runner', '.credentials', '.credentials_rsaparams'];

    for (const file of configFiles) {
      const filePath = path.join(configDir, file);
      try {
        await fs.promises.unlink(filePath);
      } catch (unlinkErr) {
        // Expected if file doesn't exist, which is fine
        const code = (unlinkErr as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          // Unexpected error - log but continue with other files
          log('error', `Failed to remove config file ${file}: ${code}`);
        }
      }
    }
  }

  /**
   * Take an instance's runner settings from a target's registration.
   * Used for multi-target support, where every worker runs as one of a
   * target's registered runners. The .runner file is modified to point to the
   * local broker proxy.
   *
   * Only the .runner is copied. The registration's credentials stay in
   * proxyBaseDir/<instance>/, where the broker reads them to make every call
   * upstream; the worker never needs them (see worker-credentials.ts).
   *
   * Directory structure:
   * proxyBaseDir/<instance>/.runner, .credentials, .credentials_rsaparams
   */
  async copyProxyCredentials(
    instance: number,
    proxyBaseDir: string,
    onLog?: (level: 'info' | 'error', message: string) => void
  ): Promise<void> {
    const log = onLog || (() => {});
    const configDir = this.getConfigDir(instance);

    // Credentials are in instance subdirectory (e.g., proxyBaseDir/1/, proxyBaseDir/2/)
    const proxyInstanceDir = path.join(proxyBaseDir, String(instance));

    // The broker cannot serve a worker for a registration it cannot sign for.
    for (const file of ['.runner', '.credentials', '.credentials_rsaparams']) {
      if (!fs.existsSync(path.join(proxyInstanceDir, file))) {
        throw new Error(`Missing proxy credential file: ${file} in ${proxyInstanceDir}`);
      }
    }

    // Ensure config directory exists
    await fs.promises.mkdir(configDir, { recursive: true });

    await fs.promises.copyFile(path.join(proxyInstanceDir, '.runner'), path.join(configDir, '.runner'));

    // Earlier versions copied the key here too. Nothing reads it from here any
    // more, so it goes rather than sit in a second place.
    for (const file of ['.credentials', '.credentials_rsaparams']) {
      await fs.promises.rm(path.join(configDir, file), { force: true });
    }

    // Modify .runner to point to local broker proxy
    const runnerConfigPath = path.join(configDir, '.runner');
    const runnerConfig = JSON.parse(
      fs.readFileSync(runnerConfigPath, 'utf-8').replace(/^\uFEFF/, '')
    );

    runnerConfig.serverUrlV2 = 'http://localhost:8787/';
    await fs.promises.writeFile(runnerConfigPath, JSON.stringify(runnerConfig, null, 2));

    log('info', `Copied proxy credentials to instance ${instance} config`);
  }

  /**
   * Configure a runner instance.
   * Builds sandbox, runs config.sh, then saves config.
   */
  async configureInstance(instance: number, version: string, options: {
    url: string;
    token: string;
    name: string;
    labels: string[];
    workFolder?: string;
    onLog?: (level: 'info' | 'error', message: string) => void;
  }): Promise<void> {
    const log = options.onLog || ((_level: string, _msg: string) => {
      // Fallback logging when no callback provided - should rarely happen in practice
    });

    // Build fresh sandbox from arc
    const sandboxDir = await this.buildSandbox(instance, version);
    const configScript = path.join(sandboxDir, 'config.sh');

    if (!fs.existsSync(configScript)) {
      throw new Error(`Runner not properly downloaded. Missing config.sh in ${sandboxDir}`);
    }

    const args = [
      '--url', options.url,
      '--name', options.name,
      '--labels', options.labels.join(','),
      '--work', options.workFolder || '_work',
      '--unattended',
      '--replace',
    ];

    await new Promise<void>((resolve, reject) => {
      const config = spawnSandboxed(configScript, args, {
        cwd: sandboxDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        // The runner reads any option from ACTIONS_RUNNER_INPUT_<NAME>, and
        // drops the variable once read. Any local user can list a process's
        // arguments; only this user can read its environment.
        env: { ...process.env, ACTIONS_RUNNER_INPUT_TOKEN: options.token },
        // Registration contacts GitHub with the user's token and runs no
        // workflow code; there is no instance proxy at this point.
        allowDirectNetwork: true,
      });

      let stdout = '';
      let stderr = '';

      config.stdout?.on('data', (data) => {
        const text = data.toString().trim();
        stdout += text;
        if (text) log('info', text);
      });

      config.stderr?.on('data', (data) => {
        const text = data.toString().trim();
        stderr += text;
        if (text) log('error', text);
      });

      config.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Configuration failed for instance ${instance} (code ${code}): ${stderr || stdout}`));
        }
      });

      config.on('error', (err) => {
        reject(err);
      });
    });

    // Save config files to persistent location
    await this.saveConfig(instance);

    // Modify .runner to route through local broker proxy if enabled
    await this.configureForBrokerProxy(instance, options.onLog);
  }

  /**
   * Modify a runner instance's config to route through the local broker proxy.
   * All workers connect through the broker proxy which routes to any target.
   */
  async configureForBrokerProxy(
    instance: number,
    onLog?: (level: 'info' | 'error', message: string) => void
  ): Promise<void> {
    const log = onLog || (() => {});
    const configDir = this.getConfigDir(instance);
    const runnerConfigPath = path.join(configDir, '.runner');

    if (!fs.existsSync(runnerConfigPath)) {
      return; // No config to update
    }

    try {
      const runnerConfig = JSON.parse(
        fs.readFileSync(runnerConfigPath, 'utf-8').replace(/^\uFEFF/, '')
      );

      // Already configured for broker proxy?
      if (runnerConfig.serverUrlV2 === 'http://localhost:8787/') {
        return;
      }

      // Store original broker URL and point to local proxy
      const originalBrokerUrl = runnerConfig.serverUrlV2;
      runnerConfig.serverUrlV2 = 'http://localhost:8787/';
      runnerConfig.originalServerUrlV2 = originalBrokerUrl; // Keep for reference

      await fs.promises.writeFile(runnerConfigPath, JSON.stringify(runnerConfig, null, 2));
      log('info', `Configured instance ${instance} to use broker proxy`);

      // Also update sandbox copy
      const sandboxDir = this.getSandboxDir(instance);
      const sandboxRunnerPath = path.join(sandboxDir, '.runner');
      if (fs.existsSync(sandboxRunnerPath)) {
        await fs.promises.writeFile(sandboxRunnerPath, JSON.stringify(runnerConfig, null, 2));
      }
    } catch (err) {
      log('error', `Failed to configure broker proxy for instance ${instance}: ${(err as Error).message}`);
    }
  }

  /**
   * Set the version to use for download.
   */
  setDownloadVersion(version: string | null): void {
    this.selectedVersion = version;
  }

  /**
   * Get the version that will be used for download.
   */
  getDownloadVersion(): string {
    return this.selectedVersion || this.fallbackVersion;
  }

  /**
   * Get the currently installed version (from arc directory).
   */
  getInstalledVersion(): string | null {
    const arcBase = path.join(this.baseDir, 'arc');
    if (!fs.existsSync(arcBase)) {
      return null;
    }

    try {
      const versions = fs.readdirSync(arcBase)
        .filter(d => d.startsWith('v'))
        .map(d => d.substring(1))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      return versions[0] || null;
    } catch {
      // Failed to read versions - could be permissions or corrupt directory
      return null;
    }
  }

  /**
   * Fetch available runner versions from GitHub Releases API.
   */
  async getAvailableVersions(): Promise<RunnerRelease[]> {
    try {
      const response = await fetch(
        'https://api.github.com/repos/actions/runner/releases?per_page=10',
        {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'localmost',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const releases = await response.json();
      return releases
        .filter((r: { prerelease: boolean; tag_name: string }) => !r.prerelease && r.tag_name.startsWith('v'))
        .map((r: { tag_name: string; html_url: string; published_at: string }) => ({
          version: r.tag_name.replace(/^v/, ''),
          url: r.html_url,
          publishedAt: r.published_at,
        }));
    } catch {
      // Network error or GitHub API issue - fall back to hardcoded version
      // This is intentional degradation, not an error worth surfacing
      return [{
        version: this.fallbackVersion,
        url: `https://github.com/actions/runner/releases/tag/v${this.fallbackVersion}`,
        publishedAt: '',
      }];
    }
  }

  /**
   * Check if a runner version is downloaded.
   */
  isDownloaded(version?: string): boolean {
    // If checking a specific version
    if (version) {
      const arcDir = this.getArcDir(version);
      return fs.existsSync(path.join(arcDir, 'run.sh'));
    }

    // Check if any version is installed
    const installed = this.getInstalledVersion();
    if (installed) {
      const arcDir = this.getArcDir(installed);
      return fs.existsSync(path.join(arcDir, 'run.sh'));
    }

    return false;
  }

  /**
   * Ensure a runner is available, downloading if needed.
   * Returns the version that is ready to use.
   */
  async ensureRunnerAvailable(onProgress?: ProgressCallback): Promise<string> {
    // If a version is already installed, use it
    const installed = this.getInstalledVersion();
    if (installed) {
      const arcDir = this.getArcDir(installed);
      if (fs.existsSync(path.join(arcDir, 'run.sh'))) {
        return installed;
      }
    }

    // Download the runner
    await this.download(onProgress || (() => {}));
    return this.getDownloadVersion();
  }

  /**
   * Check if an instance is configured.
   * @deprecated For proxy-only mode, use hasAnyProxyCredentials() instead
   */
  isConfigured(instance: number): boolean {
    const configDir = this.getConfigDir(instance);
    return fs.existsSync(path.join(configDir, '.runner'));
  }

  /**
   * Check if any proxy credentials exist (multi-target mode).
   * Returns true if at least one target has proxy credentials.
   *
   * Directory structure:
   * proxies/<target-id>/1/.runner  (instance 1)
   * proxies/<target-id>/2/.runner  (instance 2)
   * ...
   */
  hasAnyProxyCredentials(): boolean {
    const proxiesDir = path.join(this.baseDir, 'proxies');
    if (!fs.existsSync(proxiesDir)) {
      return false;
    }

    try {
      // Iterate target directories
      const targetEntries = fs.readdirSync(proxiesDir, { withFileTypes: true });
      for (const targetEntry of targetEntries) {
        if (targetEntry.isDirectory()) {
          const targetDir = path.join(proxiesDir, targetEntry.name);
          // Check for numbered instance subdirectories
          const instanceEntries = fs.readdirSync(targetDir, { withFileTypes: true });
          for (const instanceEntry of instanceEntries) {
            // Instance directories are numbered (1, 2, 3, etc.)
            if (instanceEntry.isDirectory() && /^\d+$/.test(instanceEntry.name)) {
              const instanceDir = path.join(targetDir, instanceEntry.name);
              const runnerFile = path.join(instanceDir, '.runner');
              if (fs.existsSync(runnerFile)) {
                return true;
              }
            }
          }
        }
      }
    } catch {
      // Error reading directory - treat as no credentials
    }
    return false;
  }

  /**
   * Get version info for display.
   */
  getVersion(): string {
    return this.getInstalledVersion() || this.getDownloadVersion();
  }

  getVersionUrl(): string {
    const version = this.getVersion();
    return `https://github.com/actions/runner/releases/tag/v${version}`;
  }

  /**
   * Clean up stale/corrupt runner configuration.
   * Removes sandbox directories (they're rebuilt fresh on each start).
   * Validates config directories have required files.
   * @param onLog - Optional logging callback
   * @param options.cleanWorkDirs - Whether to clean work directories (default: true)
   */
  async cleanupStaleConfiguration(
    onLog?: (message: string) => void,
    options?: { cleanWorkDirs?: boolean }
  ): Promise<void> {
    const log = onLog || (() => {});
    const shouldCleanWorkDirs = options?.cleanWorkDirs ?? true;

    const sandboxBase = path.join(this.baseDir, 'sandbox');
    if (fs.existsSync(sandboxBase)) {
      log('Cleaning up stale sandbox directories...');

      // Kill orphaned processes first (before deleting their PID files)
      const killedAny = await killOrphanedProcesses(sandboxBase, log);
      if (killedAny) {
        log('Waiting for orphaned sessions to expire...');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      // Clean up sandbox directories
      await cleanupSandboxDirectories(sandboxBase, log);
    }

    // Clean up incomplete config directories
    const configBase = path.join(this.baseDir, 'config');
    await cleanupIncompleteConfigs(configBase, log);

    // Clean up preserved work directories (unless disabled)
    if (shouldCleanWorkDirs) {
      await this.cleanupWorkDirectories(log);
    }
  }

  /**
   * Clean up preserved work directories.
   * Called on startup and exit to avoid accumulating stale data.
   */
  async cleanupWorkDirectories(onLog?: (message: string) => void): Promise<void> {
    const workBase = path.join(this.baseDir, 'work');
    await cleanupWorkDirs(workBase, onLog || (() => {}));
  }

  /** The release tarball for a version on this Mac's architecture. */
  private releaseAsset(version: string): { filename: string; url: string } {
    const arch = this.getArch();
    if (!arch) {
      throw new Error(`Unsupported architecture: ${process.arch}`);
    }
    const filename = `actions-runner-${this.getPlatform()}-${arch}-${version}.tar.gz`;
    return { filename, url: `https://github.com/actions/runner/releases/download/v${version}/${filename}` };
  }

  async download(onProgress: ProgressCallback): Promise<void> {

    const version = this.getDownloadVersion();
    const { filename, url: downloadUrl } = this.releaseAsset(version);
    const arcDir = this.getArcDir(version);

    // Create arc directory
    await fs.promises.mkdir(arcDir, { recursive: true });

    const tarballPath = path.join(arcDir, filename);

    try {
      // Fetch expected checksum first
      onProgress({ phase: 'downloading', percent: 0, message: 'Fetching checksum...' });
      const expectedChecksum = await this.fetchExpectedChecksum(version, filename);

      // Download the tarball
      onProgress({ phase: 'downloading', percent: 0, message: 'Starting download...' });

      await this.downloadFile(downloadUrl, tarballPath, (percent) => {
        onProgress({
          phase: 'downloading',
          percent,
          message: `Downloading runner (${percent}%)...`,
        });
      });

      // Verify checksum before extraction
      onProgress({ phase: 'extracting', percent: 0, message: 'Verifying checksum...' });
      await this.verifyChecksum(tarballPath, expectedChecksum);

      // Extract the tarball
      onProgress({ phase: 'extracting', percent: 0, message: 'Extracting runner...' });

      await tar.extract({
        file: tarballPath,
        cwd: arcDir,
        preserveOwner: false,
      });

      // Clean up tarball
      await fs.promises.unlink(tarballPath);

      // Make scripts executable
      const scripts = ['run.sh', 'config.sh', 'svc.sh'];
      for (const script of scripts) {
        const scriptPath = path.join(arcDir, script);
        if (fs.existsSync(scriptPath)) {
          await fs.promises.chmod(scriptPath, 0o755);
        }
      }

      const listenerPath = path.join(arcDir, 'bin', 'Runner.Listener');
      if (fs.existsSync(listenerPath)) {
        await fs.promises.chmod(listenerPath, 0o755);
      }

      // Recorded now, from what was just extracted from a checked download,
      // before any worker exists that could have touched it.
      await this.recordArcManifest(version);

      onProgress({ phase: 'complete', percent: 100, message: 'Runner downloaded and ready!' });
    } catch (error) {
      // Clean up failed download
      if (fs.existsSync(arcDir)) {
        await fs.promises.rm(arcDir, { recursive: true, force: true });
      }
      onProgress({
        phase: 'error',
        percent: 0,
        message: `Download failed: ${(error as Error).message}`,
      });
      throw error;
    }
  }

  private getPlatform(): string {
    return 'osx';
  }

  private getArch(): string | null {
    // macOS supports both Intel (x64) and Apple Silicon (arm64)
    if (process.arch === 'x64' || process.arch === 'arm64') {
      return process.arch;
    }
    return null;
  }

  /**
   * Fetch the expected SHA256 checksum from GitHub releases.
   *
   * SECURITY MODEL:
   * - Checksum verification detects download corruption and tampering in transit
   * - Both binary and checksum come from GitHub, so this trusts GitHub's infrastructure
   * - The runner binaries use adhoc code signatures (no verified identity), so we don't
   *   verify signatures—the checksum provides equivalent integrity assurance
   * - For maximum security, users can verify the runner against GitHub's published hashes
   *   at: https://github.com/actions/runner/releases
   *
   * This is consistent with localmost's overall security model which trusts GitHub
   * for OAuth, API access, and runner binary distribution.
   */
  private async fetchExpectedChecksum(version: string, filename: string): Promise<string> {
    const apiUrl = `https://api.github.com/repos/actions/runner/releases/tags/v${version}`;

    const response = await fetch(apiUrl, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'localmost',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch release info: ${response.status} ${response.statusText}`);
    }

    const release = await response.json();
    const body = release.body || '';

    // Parse checksum from release body
    // Format: "<!-- BEGIN SHA osx-arm64 -->hash<!-- END SHA osx-arm64 -->"
    const match = filename.match(/^actions-runner-([^-]+-[^-]+)-/);
    if (!match) {
      throw new Error(`Could not parse platform from filename: ${filename}`);
    }
    const platformKey = match[1];

    const beginMarker = `<!-- BEGIN SHA ${platformKey} -->`;
    const endMarker = `<!-- END SHA ${platformKey} -->`;

    const beginIndex = body.indexOf(beginMarker);
    if (beginIndex === -1) {
      throw new Error(`Checksum not found for ${platformKey} in release notes`);
    }

    const hashStart = beginIndex + beginMarker.length;
    const hashEnd = body.indexOf(endMarker, hashStart);
    if (hashEnd === -1) {
      throw new Error(`Checksum end marker not found for ${platformKey}`);
    }

    const hash = body.substring(hashStart, hashEnd).trim().toLowerCase();

    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`Invalid checksum format: ${hash}`);
    }

    return hash;
  }

  private async computeFileChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = createReadStream(filePath);

      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  private async verifyChecksum(filePath: string, expectedHash: string): Promise<void> {
    const actualHash = await this.computeFileChecksum(filePath);

    if (actualHash !== expectedHash) {
      throw new Error(
        `Checksum verification failed!\n` +
        `Expected: ${expectedHash}\n` +
        `Actual:   ${actualHash}\n` +
        `The downloaded file may be corrupted or tampered with.`
      );
    }
  }

  /**
   * Download a file using parallel chunk downloads for faster speeds.
   */
  private async downloadFile(
    url: string,
    destPath: string,
    onProgress: (percent: number) => void
  ): Promise<void> {
    const CHUNK_COUNT = 8; // Number of parallel connections

    // First, get the file size and check if server supports range requests
    const headResponse = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (!headResponse.ok) {
      throw new Error(`Failed to get file info: ${headResponse.status}`);
    }

    const contentLength = parseInt(headResponse.headers.get('content-length') || '0', 10);
    const acceptRanges = headResponse.headers.get('accept-ranges');
    const finalUrl = headResponse.url; // Get the final URL after redirects

    // If server doesn't support range requests or file is small, use simple download
    if (!acceptRanges || acceptRanges === 'none' || contentLength < 1024 * 1024) {
      return this.downloadFileSingle(finalUrl, destPath, contentLength, onProgress);
    }

    // Calculate chunk sizes
    const chunkSize = Math.ceil(contentLength / CHUNK_COUNT);
    const chunks: Array<{ start: number; end: number; index: number }> = [];

    for (let i = 0; i < CHUNK_COUNT; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize - 1, contentLength - 1);
      if (start <= contentLength - 1) {
        chunks.push({ start, end, index: i });
      }
    }

    // Pre-allocate the file
    const fd = await fs.promises.open(destPath, 'w');
    await fd.truncate(contentLength);

    // Track progress for each chunk
    const chunkProgress = new Array(chunks.length).fill(0);
    let lastReportedPercent = 0;

    const updateProgress = () => {
      const totalDownloaded = chunkProgress.reduce((a, b) => a + b, 0);
      const percent = Math.round((totalDownloaded / contentLength) * 100);
      if (percent !== lastReportedPercent) {
        lastReportedPercent = percent;
        onProgress(percent);
      }
    };

    // Download all chunks in parallel
    try {
      await Promise.all(
        chunks.map(async (chunk) => {
          const response = await fetch(finalUrl, {
            headers: {
              Range: `bytes=${chunk.start}-${chunk.end}`,
            },
          });

          if (!response.ok && response.status !== 206) {
            throw new Error(`Chunk download failed: ${response.status}`);
          }

          const reader = response.body?.getReader();
          if (!reader) {
            throw new Error('Failed to get chunk reader');
          }

          let position = chunk.start;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const buffer = Buffer.from(value);
            await fd.write(buffer, 0, buffer.length, position);
            position += buffer.length;

            chunkProgress[chunk.index] += buffer.length;
            updateProgress();
          }
        })
      );
    } finally {
      await fd.close();
    }
  }

  /**
   * Simple single-stream download (fallback for servers that don't support Range).
   */
  private async downloadFileSingle(
    url: string,
    destPath: string,
    contentLength: number,
    onProgress: (percent: number) => void
  ): Promise<void> {
    const response = await fetch(url, { redirect: 'follow' });

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Failed to get response reader');
    }

    const fileStream = createWriteStream(destPath);
    let downloadedBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        fileStream.write(Buffer.from(value));
        downloadedBytes += value.length;

        if (contentLength > 0) {
          const percent = Math.round((downloadedBytes / contentLength) * 100);
          onProgress(percent);
        }
      }
    } finally {
      // Waited for: the checksum is read from this file as soon as this
      // returns, and writes may still be queued.
      await new Promise<void>((resolve) => fileStream.end(() => resolve()));
    }
  }
}
