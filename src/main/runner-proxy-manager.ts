/**
 * Runner Proxy Manager
 *
 * Manages "phantom" runner registrations with GitHub for multi-target support.
 * Each target gets N runner registrations (one per parallel job slot) that
 * maintain broker sessions.
 *
 * Directory structure:
 * ~/.localmost/runner/proxies/<target-id>/
 *   1/.runner, 1/.credentials, 1/.credentials_rsaparams  - Runner instance 1
 *   2/.runner, 2/.credentials, 2/.credentials_rsaparams  - Runner instance 2
 *   ...
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { getRunnerDir } from './paths';
import { getGitHubAuth, getRunnerDownloader, getLogger } from './app-state';
import { getValidAccessToken } from './auth-tokens';
import type { Target } from '../shared/types';

// ============================================================================
// Types
// ============================================================================

/** Runner config from .runner file */
export interface RunnerFileConfig {
  agentId: number;
  agentName: string;
  poolId: number;
  poolName: string;
  serverUrl: string;
  gitHubUrl: string;
  workFolder: string;
  useV2Flow: boolean;
  serverUrlV2: string;
}

/** Credentials from .credentials file */
export interface CredentialsFile {
  scheme: string;
  data: {
    clientId: string;
    authorizationUrl: string;
    requireFipsCryptography: string;
  };
}

/** RSA parameters from .credentials_rsaparams file */
export interface RSAParamsFile {
  d: string;
  dp: string;
  dq: string;
  exponent: string;
  inverseQ: string;
  modulus: string;
  p: string;
  q: string;
}

/** Loaded credentials for a target */
export interface ProxyCredentials {
  runner: RunnerFileConfig;
  credentials: CredentialsFile;
  rsaParams: RSAParamsFile;
}

// ============================================================================
// Helpers
// ============================================================================

/** Remove BOM from JSON files (Windows encoding) */
const removeBOM = (str: string): string => str.replace(/^\uFEFF/, '');

/** Get base proxy directory for a target */
const getProxyBaseDir = (targetId: string): string => {
  return path.join(getRunnerDir(), 'proxies', targetId);
};

/** Get proxy credentials directory for a specific instance of a target */
const getProxyInstanceDir = (targetId: string, instanceNum: number): string => {
  return path.join(getProxyBaseDir(targetId), String(instanceNum));
};

// ============================================================================
// Runner Proxy Manager
// ============================================================================

export class RunnerProxyManager {
  private registeredTargets: Set<string> = new Set();

  /**
   * Check if a target has any registered instances.
   */
  hasCredentials(targetId: string): boolean {
    const baseDir = getProxyBaseDir(targetId);
    if (!fs.existsSync(baseDir)) return false;

    // Check if any numbered subdirectory has credentials
    try {
      const entries = fs.readdirSync(baseDir);
      return entries.some(entry => {
        const num = parseInt(entry, 10);
        if (isNaN(num)) return false;
        const instanceDir = path.join(baseDir, entry);
        if (!fs.statSync(instanceDir).isDirectory()) return false;
        const credFiles = ['.runner', '.credentials', '.credentials_rsaparams'];
        return credFiles.every(file => fs.existsSync(path.join(instanceDir, file)));
      });
    } catch {
      return false;
    }
  }

  /**
   * Get the count of registered instances for a target.
   */
  getInstanceCount(targetId: string): number {
    const baseDir = getProxyBaseDir(targetId);
    if (!fs.existsSync(baseDir)) return 0;

    try {
      const entries = fs.readdirSync(baseDir);
      return entries.filter(entry => {
        const num = parseInt(entry, 10);
        if (isNaN(num)) return false;
        const instanceDir = path.join(baseDir, entry);
        if (!fs.statSync(instanceDir).isDirectory()) return false;
        return fs.existsSync(path.join(instanceDir, '.runner'));
      }).length;
    } catch {
      return 0;
    }
  }

  /**
   * Load credentials for a specific instance of a target.
   * Returns null if credentials don't exist or are invalid.
   */
  loadCredentials(targetId: string, instanceNum: number): ProxyCredentials | null {
    const instanceDir = getProxyInstanceDir(targetId, instanceNum);
    const log = () => getLogger();

    try {
      const runner = JSON.parse(removeBOM(
        fs.readFileSync(path.join(instanceDir, '.runner'), 'utf-8')
      )) as RunnerFileConfig;

      const credentials = JSON.parse(removeBOM(
        fs.readFileSync(path.join(instanceDir, '.credentials'), 'utf-8')
      )) as CredentialsFile;

      const rsaParams = JSON.parse(removeBOM(
        fs.readFileSync(path.join(instanceDir, '.credentials_rsaparams'), 'utf-8')
      )) as RSAParamsFile;

      return { runner, credentials, rsaParams };
    } catch (error) {
      log()?.debug(`[RunnerProxyManager] Failed to load credentials for ${targetId}/${instanceNum}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Load all credentials for a target.
   * Returns array of credentials with instance numbers.
   */
  loadAllCredentials(targetId: string): Array<{ instanceNum: number } & ProxyCredentials> {
    const baseDir = getProxyBaseDir(targetId);
    if (!fs.existsSync(baseDir)) return [];

    const results: Array<{ instanceNum: number } & ProxyCredentials> = [];

    try {
      const entries = fs.readdirSync(baseDir);
      for (const entry of entries) {
        const num = parseInt(entry, 10);
        if (isNaN(num)) continue;

        const creds = this.loadCredentials(targetId, num);
        if (creds) {
          results.push({ instanceNum: num, ...creds });
        }
      }
    } catch {
      // Ignore errors
    }

    return results.sort((a, b) => a.instanceNum - b.instanceNum);
  }

  /**
   * Register all runner instances for a target.
   * Creates N GitHub runner registrations and stores credentials locally.
   */
  async registerAll(target: Target, count: number): Promise<Array<{ instanceNum: number } & ProxyCredentials>> {
    const log = () => getLogger();
    log()?.info(`[RunnerProxyManager] Registering ${count} proxies for ${target.displayName}...`);

    const results: Array<{ instanceNum: number } & ProxyCredentials> = [];

    for (let i = 1; i <= count; i++) {
      const creds = await this.registerInstance(target, i);
      results.push({ instanceNum: i, ...creds });
    }

    this.registeredTargets.add(target.id);
    log()?.info(`[RunnerProxyManager] Successfully registered ${count} proxies for ${target.displayName}`);

    return results;
  }

  /**
   * Register a single runner instance for a target.
   * The runner name will have a .N suffix (e.g., localmost.blue-243.myrepo.1)
   */
  async registerInstance(target: Target, instanceNum: number): Promise<ProxyCredentials> {
    const githubAuth = getGitHubAuth();
    const runnerDownloader = getRunnerDownloader();
    const log = () => getLogger();

    if (!githubAuth || !runnerDownloader) {
      throw new Error('Runner not initialized');
    }

    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      throw new Error('Not authenticated');
    }

    const runnerName = `${target.proxyRunnerName}.${instanceNum}`;
    log()?.info(`[RunnerProxyManager] Registering instance ${instanceNum} as ${runnerName}...`);

    // Get registration token
    let registrationToken: string;
    let configUrl: string;

    if (target.type === 'org') {
      registrationToken = await githubAuth.getOrgRunnerRegistrationToken(accessToken, target.owner);
      configUrl = `https://github.com/${target.owner}`;
    } else {
      registrationToken = await githubAuth.getRunnerRegistrationToken(accessToken, target.owner, target.repo!);
      configUrl = target.url;
    }

    // Get installed runner version
    const version = runnerDownloader.getInstalledVersion();
    if (!version) {
      throw new Error('No runner version installed');
    }

    // Create instance directory
    const instanceDir = getProxyInstanceDir(target.id, instanceNum);
    await fs.promises.mkdir(instanceDir, { recursive: true });

    // Build a temporary sandbox for configuration
    const sandboxDir = await this.buildTempSandbox(version);

    try {
      // Run config.sh to register the runner
      await this.runConfigScript(sandboxDir, {
        url: configUrl,
        token: registrationToken,
        name: runnerName,
        labels: ['localmost-proxy'],
      });

      // Copy credential files to instance directory
      const credFiles = ['.runner', '.credentials', '.credentials_rsaparams'];
      for (const file of credFiles) {
        const srcPath = path.join(sandboxDir, file);
        const destPath = path.join(instanceDir, file);
        if (fs.existsSync(srcPath)) {
          await fs.promises.copyFile(srcPath, destPath);
        } else {
          throw new Error(`Missing credential file: ${file}`);
        }
      }

      // Modify .runner to point to broker.actions.githubusercontent.com
      const runnerConfig = JSON.parse(removeBOM(
        await fs.promises.readFile(path.join(instanceDir, '.runner'), 'utf-8')
      ));
      runnerConfig.serverUrlV2 = 'https://broker.actions.githubusercontent.com/';
      await fs.promises.writeFile(
        path.join(instanceDir, '.runner'),
        JSON.stringify(runnerConfig, null, 2)
      );

      log()?.info(`[RunnerProxyManager] Registered instance ${instanceNum} for ${target.displayName}`);

      // Load and return the credentials
      const credentials = this.loadCredentials(target.id, instanceNum);
      if (!credentials) {
        throw new Error('Failed to load credentials after registration');
      }
      return credentials;
    } finally {
      // Clean up temporary sandbox
      await fs.promises.rm(sandboxDir, { recursive: true, force: true });
    }
  }

  /**
   * Unregister all runner instances for a target.
   * Removes all GitHub registrations and local credentials.
   */
  async unregisterAll(target: Target): Promise<void> {
    const githubAuth = getGitHubAuth();
    const log = () => getLogger();

    log()?.info(`[RunnerProxyManager] Unregistering all proxies for ${target.displayName}...`);

    // Get all registered instances
    const instanceCount = this.getInstanceCount(target.id);

    // Try to delete from GitHub
    if (githubAuth) {
      const accessToken = await getValidAccessToken();
      if (accessToken) {
        try {
          let runners: Array<{ id: number; name: string; status: string }>;

          if (target.type === 'org') {
            runners = await githubAuth.listOrgRunners(accessToken, target.owner);
          } else {
            runners = await githubAuth.listRunners(accessToken, target.owner, target.repo!);
          }

          // Find and delete all runners matching this target's pattern
          const runnerPrefix = `${target.proxyRunnerName}.`;
          const matchingRunners = runners.filter(r =>
            r.name === target.proxyRunnerName || r.name.startsWith(runnerPrefix)
          );

          for (const runner of matchingRunners) {
            try {
              if (target.type === 'org') {
                await githubAuth.deleteOrgRunner(accessToken, target.owner, runner.id);
              } else {
                await githubAuth.deleteRunner(accessToken, target.owner, target.repo!, runner.id);
              }
              log()?.info(`[RunnerProxyManager] Deleted GitHub registration for ${runner.name}`);
            } catch (error) {
              log()?.warn(`[RunnerProxyManager] Could not delete ${runner.name}: ${(error as Error).message}`);
            }
          }
        } catch (error) {
          log()?.warn(`[RunnerProxyManager] Could not list/delete GitHub registrations: ${(error as Error).message}`);
        }
      }
    }

    // Remove local credentials directory
    const baseDir = getProxyBaseDir(target.id);
    try {
      await fs.promises.rm(baseDir, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }

    this.registeredTargets.delete(target.id);
    log()?.info(`[RunnerProxyManager] Unregistered ${instanceCount} proxies for ${target.displayName}`);
  }

  /**
   * Clear credentials for a target without deleting GitHub registration.
   * Used when re-registration is needed. Removes all instance directories.
   */
  async clearCredentials(targetId: string): Promise<void> {
    const baseDir = getProxyBaseDir(targetId);

    try {
      await fs.promises.rm(baseDir, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }

    this.registeredTargets.delete(targetId);
  }

  /**
   * Build a temporary sandbox directory with runner binaries.
   */
  private async buildTempSandbox(version: string): Promise<string> {
    const runnerDownloader = getRunnerDownloader();
    if (!runnerDownloader) {
      throw new Error('Runner downloader not available');
    }

    const arcDir = runnerDownloader.getArcDir(version);
    if (!fs.existsSync(arcDir)) {
      throw new Error(`Runner version ${version} not downloaded`);
    }

    // Create temp sandbox
    const tempDir = path.join(getRunnerDir(), 'temp-proxy-' + Date.now());
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Copy arc contents to temp sandbox
    await this.copyDir(arcDir, tempDir);

    return tempDir;
  }

  /**
   * Copy directory recursively.
   */
  private async copyDir(src: string, dest: string): Promise<void> {
    await fs.promises.mkdir(dest, { recursive: true });
    const entries = await fs.promises.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDir(srcPath, destPath);
      } else {
        await fs.promises.copyFile(srcPath, destPath);
        // Preserve executable permissions
        const stat = await fs.promises.stat(srcPath);
        await fs.promises.chmod(destPath, stat.mode);
      }
    }
  }

  /**
   * Run config.sh to register a runner.
   */
  private async runConfigScript(
    sandboxDir: string,
    options: { url: string; token: string; name: string; labels: string[] }
  ): Promise<void> {
    const configScript = path.join(sandboxDir, 'config.sh');
    const log = () => getLogger();

    if (!fs.existsSync(configScript)) {
      throw new Error(`config.sh not found in ${sandboxDir}`);
    }

    const args = [
      '--url', options.url,
      '--token', options.token,
      '--name', options.name,
      '--labels', options.labels.join(','),
      '--work', '_work',
      '--unattended',
      '--replace',
    ];

    return new Promise<void>((resolve, reject) => {
      const proc = spawn(configScript, args, {
        cwd: sandboxDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        const text = data.toString().trim();
        stdout += text + '\n';
        if (text) log()?.debug(`[config.sh] ${text}`);
      });

      proc.stderr?.on('data', (data) => {
        const text = data.toString().trim();
        stderr += text + '\n';
        if (text) log()?.warn(`[config.sh] ${text}`);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`config.sh failed (code ${code}): ${stderr || stdout}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to run config.sh: ${err.message}`));
      });
    });
  }
}

// Singleton instance
let instance: RunnerProxyManager | null = null;

export const getRunnerProxyManager = (): RunnerProxyManager => {
  if (!instance) {
    instance = new RunnerProxyManager();
  }
  return instance;
};
