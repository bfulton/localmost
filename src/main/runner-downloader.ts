import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createWriteStream, createReadStream } from 'fs';
import * as tar from 'tar';
import { FALLBACK_RUNNER_VERSION } from '../shared/constants';
import { spawnSandboxed } from './process-sandbox';
import { getRunnerDir } from './paths';
import {
  validateChildPath,
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

  constructor() {
    this.baseDir = getRunnerDir();
  }

  // validateChildPath is now imported from runner-cleanup.ts

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
    await this.copyDir(arcDir, sandboxDir);
    log('info', `Arc copy completed in ${Date.now() - copyStart}ms`);

    // Verify critical files exist
    const criticalFiles = ['run.sh', 'bin/Runner.Listener'];
    for (const file of criticalFiles) {
      const filePath = path.join(sandboxDir, file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Critical file missing after copy: ${file}`);
      }
    }

    // Copy config files into sandbox (if config exists)
    if (fs.existsSync(configDir)) {
      const configFiles = await fs.promises.readdir(configDir);
      for (const file of configFiles) {
        // Security: Validate paths stay within their respective directories
        const srcPath = validateChildPath(configDir, file);
        const destPath = validateChildPath(sandboxDir, file);
        if (!srcPath || !destPath) {
          log('error', `Skipping suspicious config file name: ${file}`);
          continue;
        }
        const stats = await fs.promises.stat(srcPath);
        if (stats.isFile()) {
          await fs.promises.copyFile(srcPath, destPath);
        }
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
   * Copy proxy credentials to an instance's config directory.
   * Used for multi-target support where workers use proxy credentials.
   * The .runner file is modified to point to the local broker proxy.
   */
  async copyProxyCredentials(
    instance: number,
    proxyDir: string,
    onLog?: (level: 'info' | 'error', message: string) => void
  ): Promise<void> {
    const log = onLog || (() => {});
    const configDir = this.getConfigDir(instance);
    const configFiles = ['.runner', '.credentials', '.credentials_rsaparams'];

    // Ensure config directory exists
    await fs.promises.mkdir(configDir, { recursive: true });

    // Copy credentials from proxy directory
    for (const file of configFiles) {
      const srcPath = path.join(proxyDir, file);
      const destPath = path.join(configDir, file);

      if (!fs.existsSync(srcPath)) {
        throw new Error(`Missing proxy credential file: ${file} in ${proxyDir}`);
      }

      await fs.promises.copyFile(srcPath, destPath);
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
      '--token', options.token,
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
   */
  hasAnyProxyCredentials(): boolean {
    const proxiesDir = path.join(this.baseDir, 'proxies');
    if (!fs.existsSync(proxiesDir)) {
      return false;
    }

    try {
      const entries = fs.readdirSync(proxiesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const proxyDir = path.join(proxiesDir, entry.name);
          const runnerFile = path.join(proxyDir, '.runner');
          if (fs.existsSync(runnerFile)) {
            return true;
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

  async download(onProgress: ProgressCallback): Promise<void> {
    const platform = this.getPlatform();
    const arch = this.getArch();

    if (!arch) {
      throw new Error(`Unsupported architecture: ${process.arch}`);
    }

    const version = this.getDownloadVersion();
    const filename = `actions-runner-${platform}-${arch}-${version}.tar.gz`;
    const downloadUrl = `https://github.com/actions/runner/releases/download/v${version}/${filename}`;
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

      // Check for GitHub attestations (best-effort, non-blocking)
      // Attestations provide additional supply chain verification when available
      onProgress({ phase: 'extracting', percent: 0, message: 'Checking attestations...' });
      await this.checkAttestations(version, filename, expectedChecksum);

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
   * Check if GitHub attestations exist for this release.
   * GitHub uses Sigstore/SLSA attestations for supply chain security.
   *
   * Note: This checks for attestation existence but does not perform full
   * cryptographic verification (which would require Sigstore client libraries).
   * The attestation check provides an additional signal that the release
   * went through GitHub's official build/release pipeline.
   *
   * @returns true if attestations were found, false otherwise
   */
  private async checkAttestations(version: string, filename: string, sha256: string): Promise<boolean> {
    try {
      // GitHub's attestation API uses the artifact digest as the subject
      const digest = `sha256:${sha256}`;
      const attestationUrl = `https://api.github.com/orgs/actions/attestations/${encodeURIComponent(digest)}`;

      const response = await fetch(attestationUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'localmost',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (response.ok) {
        const data = await response.json();
        const attestations = data.attestations || [];
        if (attestations.length > 0) {
          return true;
        }
      }

      // Attestations may not be available for older releases - this is fine
      return false;
    } catch {
      // Attestation check is best-effort - don't fail the download
      // Common causes: network issues, API rate limits, older releases
      return false;
    }
  }

  /**
   * Fetch the expected SHA256 checksum from GitHub releases.
   *
   * SECURITY MODEL:
   * - Checksum verification detects download corruption and tampering in transit
   * - Both binary and checksum come from GitHub, so this trusts GitHub's infrastructure
   * - Additional attestation checks verify the release went through official build pipeline
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
      fileStream.close();
    }
  }
}
