/**
 * Runner Proxy Manager
 *
 * Manages "phantom" runner registrations with GitHub for multi-target support.
 * Each target gets its own runner registration that maintains broker sessions.
 *
 * Directory structure:
 * ~/.localmost/runner/proxies/<target-id>/
 *   .runner              - Runner config (agent ID, URLs, etc.)
 *   .credentials         - OAuth credentials
 *   .credentials_rsaparams - RSA private key for JWT signing
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

/** Get proxy credentials directory for a target */
const getProxyDir = (targetId: string): string => {
  return path.join(getRunnerDir(), 'proxies', targetId);
};

// ============================================================================
// Runner Proxy Manager
// ============================================================================

export class RunnerProxyManager {
  private registeredTargets: Set<string> = new Set();

  /**
   * Check if a target has credentials (was previously registered).
   */
  hasCredentials(targetId: string): boolean {
    const proxyDir = getProxyDir(targetId);
    const credFiles = ['.runner', '.credentials', '.credentials_rsaparams'];
    return credFiles.every(file => fs.existsSync(path.join(proxyDir, file)));
  }

  /**
   * Load credentials for a target.
   * Returns null if credentials don't exist or are invalid.
   */
  loadCredentials(targetId: string): ProxyCredentials | null {
    const proxyDir = getProxyDir(targetId);
    const log = () => getLogger();

    try {
      const runner = JSON.parse(removeBOM(
        fs.readFileSync(path.join(proxyDir, '.runner'), 'utf-8')
      )) as RunnerFileConfig;

      const credentials = JSON.parse(removeBOM(
        fs.readFileSync(path.join(proxyDir, '.credentials'), 'utf-8')
      )) as CredentialsFile;

      const rsaParams = JSON.parse(removeBOM(
        fs.readFileSync(path.join(proxyDir, '.credentials_rsaparams'), 'utf-8')
      )) as RSAParamsFile;

      return { runner, credentials, rsaParams };
    } catch (error) {
      log()?.debug(`[RunnerProxyManager] Failed to load credentials for ${targetId}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Register a runner proxy for a target.
   * This creates a GitHub runner registration and stores the credentials locally.
   */
  async register(target: Target): Promise<ProxyCredentials> {
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

    log()?.info(`[RunnerProxyManager] Registering proxy for ${target.displayName}...`);

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

    // Create proxy directory
    const proxyDir = getProxyDir(target.id);
    await fs.promises.mkdir(proxyDir, { recursive: true });

    // Build a temporary sandbox for configuration
    const sandboxDir = await this.buildTempSandbox(version);

    try {
      // Run config.sh to register the runner
      await this.runConfigScript(sandboxDir, {
        url: configUrl,
        token: registrationToken,
        name: target.proxyRunnerName,
        labels: ['localmost-proxy'],
      });

      // Copy credential files to proxy directory
      const credFiles = ['.runner', '.credentials', '.credentials_rsaparams'];
      for (const file of credFiles) {
        const srcPath = path.join(sandboxDir, file);
        const destPath = path.join(proxyDir, file);
        if (fs.existsSync(srcPath)) {
          await fs.promises.copyFile(srcPath, destPath);
        } else {
          throw new Error(`Missing credential file: ${file}`);
        }
      }

      // Modify .runner to point to broker.actions.githubusercontent.com
      const runnerConfig = JSON.parse(removeBOM(
        await fs.promises.readFile(path.join(proxyDir, '.runner'), 'utf-8')
      ));
      runnerConfig.serverUrlV2 = 'https://broker.actions.githubusercontent.com/';
      await fs.promises.writeFile(
        path.join(proxyDir, '.runner'),
        JSON.stringify(runnerConfig, null, 2)
      );

      this.registeredTargets.add(target.id);
      log()?.info(`[RunnerProxyManager] Successfully registered proxy for ${target.displayName}`);

      // Load and return the credentials
      const credentials = this.loadCredentials(target.id);
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
   * Unregister a runner proxy for a target.
   * This removes the GitHub registration and local credentials.
   */
  async unregister(target: Target): Promise<void> {
    const githubAuth = getGitHubAuth();
    const log = () => getLogger();

    log()?.info(`[RunnerProxyManager] Unregistering proxy for ${target.displayName}...`);

    // Try to delete from GitHub first
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

          const runner = runners.find(r => r.name === target.proxyRunnerName);
          if (runner) {
            if (target.type === 'org') {
              await githubAuth.deleteOrgRunner(accessToken, target.owner, runner.id);
            } else {
              await githubAuth.deleteRunner(accessToken, target.owner, target.repo!, runner.id);
            }
            log()?.info(`[RunnerProxyManager] Deleted GitHub registration for ${target.proxyRunnerName}`);
          }
        } catch (error) {
          log()?.warn(`[RunnerProxyManager] Could not delete GitHub registration: ${(error as Error).message}`);
        }
      }
    }

    // Remove local credentials
    const proxyDir = getProxyDir(target.id);
    try {
      await fs.promises.rm(proxyDir, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }

    this.registeredTargets.delete(target.id);
    log()?.info(`[RunnerProxyManager] Unregistered proxy for ${target.displayName}`);
  }

  /**
   * Clear credentials for a target without deleting GitHub registration.
   * Used when re-registration is needed.
   */
  async clearCredentials(targetId: string): Promise<void> {
    const proxyDir = getProxyDir(targetId);
    const credFiles = ['.runner', '.credentials', '.credentials_rsaparams'];

    for (const file of credFiles) {
      try {
        await fs.promises.unlink(path.join(proxyDir, file));
      } catch {
        // Ignore errors
      }
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
