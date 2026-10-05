import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createWriteStream, createReadStream } from 'fs';
import * as tar from 'tar';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { FALLBACK_RUNNER_VERSION } from '../shared/constants';
import { getRunnerDir } from './paths';
import { SHARE_DIR_NAME, SHARE_NONCE_FILE } from './vm/paths';
import {
  cleanupSandboxDirectories,
  cleanupIncompleteConfigs,
  cleanupWorkDirectories as cleanupWorkDirs,
  moveAsideForRemoval,
  removeMovedAside,
  REMOVAL_PREFIX,
} from './runner-cleanup';

export interface DownloadProgress {
  phase: 'downloading' | 'extracting' | 'complete' | 'error';
  percent: number;
  message: string;
}

export type ProgressCallback = (progress: DownloadProgress) => void;

/** The only files buildSandbox takes from an instance's config directory. */
const SANDBOX_CONFIG_FILES = ['.runner'];

/** Where a runner release is downloaded and extracted before it is used. */
const ARC_STAGING_PREFIX = 'arc-staging-';
/** Where registration runs config.sh: a copy of the runner, and the key it makes. */
const REGISTRATION_PREFIX = 'temp-proxy-';

/**
 * Staging and registration directories still in use, which a sweep leaves
 * alone. Shared by every RunnerDownloader, since the app builds more than one
 * and the one that sweeps is not the only one that makes them.
 */
const scratchInUse = new Set<string>();

const execFileAsync = promisify(execFile);

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
 *   sandbox/1-<id>/   - one start of instance 1: a directory of its own for
 *                       every start, removed once that worker is done
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

  /** Where every worker's sandbox is built, one directory per start. */
  getSandboxBase(): string {
    return path.join(this.baseDir, 'sandbox');
  }

  /** Get the base runner directory */
  getBaseDir(): string {
    return this.baseDir;
  }

  /**
   * Where a version's integrity record lives: beside arc/, not in it, so a
   * version directory holds exactly what its release did.
   */
  getArcManifestPath(version: string): string {
    return path.join(this.baseDir, 'arc-manifests', `v${version}.json`);
  }

  /**
   * A fresh directory for a release download and its extracted tree. It sits
   * in the runner directory, where jobs cannot write and where a rename into
   * arc/ stays on one filesystem. One left behind by a quit mid-download is
   * swept at the next startup.
   */
  private makeStagingDir(): Promise<string> {
    return this.makeScratchDir(ARC_STAGING_PREFIX);
  }

  /**
   * A fresh directory for one registration to run config.sh in, which only
   * the app can open: a copy of the runner goes in, and config.sh leaves the
   * registration's key beside it. Its name is unique to this call. Hand it
   * back to removeRegistrationDir once done; one left behind by a quit
   * mid-registration is swept at the next startup.
   */
  makeRegistrationDir(): Promise<string> {
    return this.makeScratchDir(REGISTRATION_PREFIX);
  }

  /** Remove a directory makeRegistrationDir made. Refuses any other path, since this deletes a whole tree. */
  async removeRegistrationDir(dir: string): Promise<void> {
    if (!scratchInUse.has(dir) || !path.basename(dir).startsWith(REGISTRATION_PREFIX)) {
      throw new Error(`Refusing to remove ${dir}: not a registration directory in ${this.baseDir}`);
    }
    await this.removeScratchDir(dir);
  }

  /** mkdtemp makes it 0700 whatever the umask, and marks it in use until removeScratchDir. */
  private async makeScratchDir(prefix: string): Promise<string> {
    await fs.promises.mkdir(this.baseDir, { recursive: true });
    const dir = await fs.promises.mkdtemp(path.join(this.baseDir, prefix));
    scratchInUse.add(dir);
    return dir;
  }

  private async removeScratchDir(dir: string): Promise<void> {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } finally {
      scratchInUse.delete(dir);
    }
  }

  /**
   * Clone a directory's contents into dest, which may already exist.
   *
   * `cp -c` clones each file with clonefile(2): the copy shares the
   * template's blocks on the volume until either side writes, so a sandbox
   * costs next to no disk and a fraction of the time a byte copy of the
   * runner took - nearly 500 MiB for every spawn. Where the volume cannot
   * clone, cp falls back to a plain copy by itself. Node's own copyFile
   * cannot clone here: on macOS its clone flag copies, and the forcing one
   * fails with ENOSYS. Links are copied as links, never followed.
   */
  private async cloneTree(src: string, dest: string): Promise<void> {
    await fs.promises.mkdir(dest, { recursive: true });
    try {
      // "src/." copies what is in src, not src itself.
      await execFileAsync('/bin/cp', ['-cR', `${src}/.`, dest], { timeout: 120_000 });
    } catch (err) {
      const e = err as Error & { stderr?: string };
      throw new Error(`Could not copy ${src} to ${dest}: ${(e.stderr || e.message).trim()}`);
    }
    await this.checkTreeEntries(dest);
  }

  /**
   * Refuse a copied tree holding anything a runner release does not: a link
   * that is absolute or leads out of the tree, or an entry that is not a
   * file, a directory or a link. The integrity record lists the release's
   * files and links, so this catches what it cannot see - a FIFO, say - and
   * holds the links to the tree whatever the record says.
   */
  private async checkTreeEntries(root: string): Promise<void> {
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
        } else if (entry.isSymbolicLink()) {
          const linkTarget = await fs.promises.readlink(entryPath);
          // An absolute link could point anywhere.
          if (path.isAbsolute(linkTarget)) {
            throw new Error(`Security violation: Absolute symlink not allowed: ${entryPath} -> ${linkTarget}`);
          }
          const resolvedTarget = path.normalize(path.join(dir, linkTarget));
          const normalizedRoot = path.normalize(root);
          if (resolvedTarget !== normalizedRoot && !resolvedTarget.startsWith(normalizedRoot + path.sep)) {
            throw new Error(
              `Security violation: Symlink escapes sandbox: ${entryPath} -> ${linkTarget} (resolves to ${resolvedTarget})`
            );
          }
        } else if (!entry.isFile()) {
          throw new Error(`Not a file, directory or link: ${entryPath}`);
        }
      }
    };
    await walk(root);
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
    await this.cloneTree(arcDir, dest);

    const differences = await this.compareWithManifest(dest, manifest);
    if (differences.length > 0) {
      // Any difference refuses, a stray .DS_Store included: the list says
      // which. The whole arc directory goes, not just this version, because
      // with this one gone the newest version left there would be used.
      log('error', `Runner v${version} in ${arcDir} does not match the release it was installed from; no runner will start from it. The differences are listed below (a file added there, even a .DS_Store left by Finder, counts). To reinstall, quit localmost, delete ${path.dirname(arcDir)}, then start localmost and download the runner again.`);
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
    const scratch = await this.makeStagingDir();
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
      await this.removeScratchDir(scratch);
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
    // The name is unique per write: a download and a first start can record
    // the same version at once.
    const staging = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.promises.writeFile(
      staging,
      JSON.stringify({ files: sorted(manifest.files), symlinks: sorted(manifest.symlinks) }),
      { mode: 0o600 }
    );
    await fs.promises.rename(staging, file);
  }

  /** The files and symlinks under a directory, by relative path; checkTreeEntries refuses anything else. */
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
   * Build a sandbox for one start of an instance, by copying arc + config
   * into a directory made for it, and return that directory.
   *
   * Never a directory an earlier start used: each start's runner files and
   * docker socket are at a path no earlier start's could be, and the
   * directory goes once that start's VM is released.
   */
  async buildSandbox(
    instance: number,
    version: string,
    onLog?: (level: 'info' | 'error', message: string) => void
  ): Promise<string> {
    const log = onLog || (() => {});
    const arcDir = this.getArcDir(version);
    const configDir = this.getConfigDir(instance);

    if (!fs.existsSync(arcDir)) {
      throw new Error(`Runner version ${version} not downloaded. Please download first.`);
    }

    // Made here, not found: mkdir without recursive refuses a name that
    // already exists, so nothing an earlier start left is built into. The id
    // is short because the docker socket goes inside, and macOS caps a unix
    // socket path at 104 bytes: <home>/.localmost/runner/sandbox/<n>-<id>/
    // docker.sock fits a home directory of up to about 49 bytes (/Users/ and
    // a 42-character user name). Past that the docker socket refuses to
    // start, and so does the worker.
    const sandboxBase = this.getSandboxBase();
    await fs.promises.mkdir(sandboxBase, { recursive: true });
    const sandboxDir = path.join(sandboxBase, `${instance}-${crypto.randomBytes(6).toString('hex')}`);
    await fs.promises.mkdir(sandboxDir);

    try {
      // The runner's work folder, which is also the one directory a Docker VM
      // is shared (contract §1): made here, by the app, with a plain mkdir
      // that refuses a name already there, before anything runs in the
      // sandbox.
      await fs.promises.mkdir(path.join(sandboxDir, SHARE_DIR_NAME));

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
    } catch (err) {
      // Nothing has run in it, so a half-built sandbox is only clutter.
      await fs.promises.rm(sandboxDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }

    // _work is as new as the sandbox. A work directory kept across starts
    // would hand one job's checkout and dependencies to whichever job next
    // took the slot, from any repository.
    return sandboxDir;
  }

  /**
   * Write the share's tripwire: a fresh random nonce in
   * `<sandbox>/_work/.localmost-share`, before the worker starts. No job
   * process runs on the Mac to read or replace the file, so when the guest
   * reads the same nonce back through its share, the share is the directory
   * this app made (the design's share rule, clause 8).
   *
   * Created exclusively: `wx` is O_CREAT|O_EXCL, which fails on any name
   * already there, a link included, dangling or not, so it never writes
   * through one.
   */
  writeShareNonce(sandboxDir: string): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(sandboxDir, SHARE_DIR_NAME, SHARE_NONCE_FILE), nonce, { flag: 'wx', mode: 0o600 });
    return nonce;
  }

  /**
   * Remove a sandbox buildSandbox made, once nothing runs in it. Refuses any
   * other path, since this deletes a whole tree. One left behind - the app
   * quit first, or something of its job outlived every sweep - goes at the
   * next startup.
   *
   * Moved out of its path first, and never removed in it, then removed
   * without following a link (see moveAsideForRemoval and removeMovedAside).
   * No job runs on this Mac - each runs in its macOS VM, which gets only the
   * runner's three files from here - so nothing should be left to steer the
   * removal; the care is kept in case something is.
   */
  async removeSandbox(sandboxDir: string): Promise<void> {
    const base = this.getSandboxBase();
    if (
      path.resolve(sandboxDir) !== sandboxDir ||
      path.dirname(sandboxDir) !== base ||
      !/^\d+-[0-9a-f]+$/.test(path.basename(sandboxDir))
    ) {
      throw new Error(`Refusing to remove ${sandboxDir}: not a sandbox in ${base}`);
    }
    const aside = await moveAsideForRemoval(sandboxDir);
    if (aside) await removeMovedAside(aside);
  }

  /**
   * Save config files from the sandbox registration ran in to the persistent
   * config directory. Should be called after configuration completes.
   */
  async saveConfig(instance: number, sandboxDir: string): Promise<void> {
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

    // Build fresh sandbox from arc: this registration's own, removed once its
    // settings are saved.
    const sandboxDir = await this.buildSandbox(instance, version);
    try {
      await this.runConfigScript(instance, sandboxDir, options, log);

      // Save config files to persistent location
      await this.saveConfig(instance, sandboxDir);
    } finally {
      await this.removeSandbox(sandboxDir).catch(() => undefined);
    }

    // Modify .runner to route through local broker proxy if enabled
    await this.configureForBrokerProxy(instance, options.onLog);
  }

  /**
   * Register an instance by running config.sh in the sandbox built for it,
   * here on the Mac and under no sandbox: registration contacts GitHub with
   * the user's token and runs no workflow code, and the copy it runs was
   * checked against the release (copyVerifiedArc).
   */
  private async runConfigScript(
    instance: number,
    sandboxDir: string,
    options: { url: string; token: string; name: string; labels: string[]; workFolder?: string },
    log: (level: 'info' | 'error', message: string) => void
  ): Promise<void> {
    const configScript = path.join(sandboxDir, 'config.sh');
    if (path.dirname(sandboxDir) !== this.getSandboxBase()) {
      throw new Error(`Refusing to register from ${sandboxDir}: not a sandbox in ${this.getSandboxBase()}`);
    }

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
      const config = spawn(configScript, args, {
        cwd: sandboxDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        // The runner reads any option from ACTIONS_RUNNER_INPUT_<NAME>, and
        // drops the variable once read. Any local user can list a process's
        // arguments; only this user can read its environment.
        env: { ...process.env, ACTIONS_RUNNER_INPUT_TOKEN: options.token },
      });

      let stdout = '';
      let stderr = '';

      config.stdout?.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        stdout += text;
        if (text) log('info', text);
      });

      config.stderr?.on('data', (data: Buffer) => {
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
      // No sandbox keeps a copy to update: each start copies it from here.
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
   * Removes sandbox directories (each start builds one of its own).
   * Validates config directories have required files.
   * @param onLog - Optional logging callback
   */
  async cleanupStaleConfiguration(onLog?: (message: string) => void): Promise<void> {
    const log = onLog || (() => {});

    const sandboxBase = this.getSandboxBase();
    if (fs.existsSync(sandboxBase)) {
      log('Cleaning up stale sandbox directories...');

      // Clean up sandbox directories. What ran from them ran in a macOS VM,
      // which the VM backend's own startup sweep stops.
      await cleanupSandboxDirectories(sandboxBase, log);
    }

    // Clean up incomplete config directories
    const configBase = path.join(this.baseDir, 'config');
    await cleanupIncompleteConfigs(configBase, log);

    // A release download interrupted by a quit leaves its staging directory
    // behind, holding the tarball and a tree extracted from it; a
    // registration leaves a copy of the runner and the key config.sh made.
    // Nothing is downloading or registering yet at startup - this runs before
    // the window's handlers are set up and before the saved sign-in that
    // registering needs is loaded - so any found are leftovers. That order is
    // what keeps a directory in use safe; skipping those marked in use is a
    // backstop, since mkdtemp makes one before it can be marked.
    await this.cleanupStagingDirectories(log);

    await this.cleanupWorkDirectories(log);

    await this.removeOrphanedCaches(log);
  }

  /**
   * Remove the per-target tool caches an earlier version kept at
   * <runner>/caches, which nothing uses now that every job runs in a macOS
   * VM. Only that one directory, named here rather than computed from
   * anything else, and only when it is a directory and not a link: a link
   * there is left, never followed. Moved aside and removed as a sandbox is;
   * a removal an earlier start could not finish is picked up from its
   * moved-aside name. A failure is logged, and the next start tries again.
   */
  private async removeOrphanedCaches(log: (message: string) => void): Promise<void> {
    const caches = path.join(this.baseDir, 'caches');
    if (path.dirname(caches) !== this.baseDir || path.basename(caches) !== 'caches') {
      throw new Error(`Refusing to remove ${caches}: not <runner>/caches`);
    }
    const leftovers = (await fs.promises.readdir(this.baseDir).catch(() => [] as string[]))
      .filter((name) => name.startsWith(REMOVAL_PREFIX))
      .map((name) => path.join(this.baseDir, name));
    let target: string | null = null;
    try {
      const st = await fs.promises.lstat(caches);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        log(`Leaving ${caches}: it is not a directory`);
      } else {
        log('Removing the tool caches an earlier version kept, which nothing uses now');
        target = await moveAsideForRemoval(caches);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log(`Could not remove ${caches} yet: ${(err as Error).message}`);
      }
    }
    for (const dir of [...leftovers, ...(target ? [target] : [])]) {
      try {
        const st = await fs.promises.lstat(dir);
        if (st.isSymbolicLink() || !st.isDirectory()) continue;
        await removeMovedAside(dir);
      } catch (err) {
        log(`Could not finish removing ${path.basename(dir)}; the next start tries again: ${(err as Error).message}`);
      }
    }
  }

  private async cleanupStagingDirectories(log: (message: string) => void): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.baseDir);
    } catch {
      return;
    }
    const kinds: Array<[string, string]> = [
      [ARC_STAGING_PREFIX, 'an interrupted runner download'],
      [REGISTRATION_PREFIX, 'an interrupted registration'],
    ];
    for (const entry of entries) {
      const kind = kinds.find(([prefix]) => entry.startsWith(prefix));
      const dir = path.join(this.baseDir, entry);
      if (!kind || scratchInUse.has(dir)) continue;
      log(`Removing ${kind[1]}: ${entry}`);
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Remove the work directories the removed preserveWorkDir setting kept
   * under runner/work. Nothing writes there any more; an install that had
   * the setting on would otherwise keep a job's checkout on disk for good.
   */
  private async cleanupWorkDirectories(log: (message: string) => void): Promise<void> {
    await cleanupWorkDirs(path.join(this.baseDir, 'work'), log);
  }

  /** The release tarball for a version, for Apple silicon. */
  private releaseAsset(version: string): { filename: string; url: string } {
    // localmost is built for Apple silicon only, so the runner it installs is
    // too; an Intel (x64) Mac is not supported.
    if (process.arch !== 'arm64') {
      throw new Error(`localmost runs on Apple silicon (arm64) only, not ${process.arch}`);
    }
    const filename = `actions-runner-${this.getPlatform()}-arm64-${version}.tar.gz`;
    return { filename, url: `https://github.com/actions/runner/releases/download/v${version}/${filename}` };
  }

  /**
   * Download a version's release and install it as arc/v<version>.
   *
   * The release is extracted into a staging directory and swapped in whole,
   * replacing any template already there. Extracting over an existing
   * directory would keep whatever else it held - a file planted beside the
   * runner, say - and the record made from it would bless that file. A failed
   * download leaves the installed template as it was.
   */
  async download(onProgress: ProgressCallback): Promise<void> {
    const version = this.getDownloadVersion();
    const { filename, url: downloadUrl } = this.releaseAsset(version);
    const arcDir = this.getArcDir(version);
    const staging = await this.makeStagingDir();
    const tarballPath = path.join(staging, filename);
    const tree = path.join(staging, 'tree');

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

      await fs.promises.mkdir(tree);
      await tar.extract({
        file: tarballPath,
        cwd: tree,
        preserveOwner: false,
      });

      // Make scripts executable
      const scripts = ['run.sh', 'config.sh', 'svc.sh'];
      for (const script of scripts) {
        const scriptPath = path.join(tree, script);
        if (fs.existsSync(scriptPath)) {
          await fs.promises.chmod(scriptPath, 0o755);
        }
      }

      const listenerPath = path.join(tree, 'bin', 'Runner.Listener');
      if (fs.existsSync(listenerPath)) {
        await fs.promises.chmod(listenerPath, 0o755);
      }

      // Recorded from what was just extracted from a checked download, before
      // it is installed and so before any worker exists that could touch it.
      await this.writeArcManifest(version, await this.manifestOf(tree));

      // Swap it in. A template it replaces is moved into the staging
      // directory and removed with it.
      await fs.promises.mkdir(path.dirname(arcDir), { recursive: true });
      if (fs.existsSync(arcDir)) {
        await fs.promises.rename(arcDir, path.join(staging, 'replaced'));
      }
      await fs.promises.rename(tree, arcDir);

      onProgress({ phase: 'complete', percent: 100, message: 'Runner downloaded and ready!' });
    } catch (error) {
      onProgress({
        phase: 'error',
        percent: 0,
        message: `Download failed: ${(error as Error).message}`,
      });
      throw error;
    } finally {
      await this.removeScratchDir(staging);
    }
  }

  private getPlatform(): string {
    return 'osx';
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
