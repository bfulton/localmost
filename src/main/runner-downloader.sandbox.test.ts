import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';
import { RunnerDownloader } from './runner-downloader';

/**
 * buildSandbox and copyProxyCredentials against a real directory tree: what a
 * worker's sandbox, which its job can read, ends up holding.
 */
describe('the sandbox a worker is built from', () => {
  const version = '9.9.9';
  let root: string;
  let runnerDir: string;
  let downloader: RunnerDownloader;
  const savedConfigDir = process.env.LOCALMOST_CONFIG_DIR;

  const write = (file: string, content: string, mode = 0o644) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode });
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sandbox-'));
    process.env.LOCALMOST_CONFIG_DIR = root;
    runnerDir = path.join(root, 'runner');
    const arc = path.join(runnerDir, 'arc', `v${version}`);
    write(path.join(arc, 'run.sh'), '#!/bin/bash\n', 0o755);
    write(path.join(arc, 'config.sh'), '#!/bin/bash\n', 0o755);
    write(path.join(arc, 'bin', 'Runner.Listener'), 'listener', 0o755);

    // What registration leaves under proxies/<target>/<n>: the registration's
    // own key, which only the app may hold.
    const proxy = path.join(runnerDir, 'proxies', 'target-a', '1');
    write(path.join(proxy, '.runner'), JSON.stringify({
      agentName: 'localmost.x.1',
      serverUrl: 'https://pipelines.actions.githubusercontent.com/abc/',
      serverUrlV2: 'https://broker.actions.githubusercontent.com/',
    }));
    write(path.join(proxy, '.credentials'), JSON.stringify({
      scheme: 'OAuth',
      data: { clientId: 'registration-client', authorizationUrl: 'https://tokenghub.actions.githubusercontent.com/_apis/oauth2/token/x', requireFipsCryptography: 'True' },
    }));
    write(path.join(proxy, '.credentials_rsaparams'), JSON.stringify({ d: 'REGISTRATION-PRIVATE-KEY' }));

    downloader = new RunnerDownloader();
    await downloader.recordArcManifest(version);
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
    else process.env.LOCALMOST_CONFIG_DIR = savedConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("never carries the registration's key or credentials into the sandbox", async () => {
    await downloader.copyProxyCredentials(1, path.join(runnerDir, 'proxies', 'target-a'));
    const sandbox = await downloader.buildSandbox(1, version);

    expect(fs.existsSync(path.join(sandbox, '.runner'))).toBe(true);
    expect(fs.existsSync(path.join(sandbox, '.credentials_rsaparams'))).toBe(false);
    expect(fs.existsSync(path.join(sandbox, '.credentials'))).toBe(false);
    // Nor a second copy app-side: nothing reads the key from the config dir.
    expect(fs.existsSync(path.join(runnerDir, 'config', '1', '.credentials_rsaparams'))).toBe(false);
    const everything = fs.readdirSync(sandbox, { recursive: true }).map(String);
    for (const file of everything) {
      const full = path.join(sandbox, file);
      if (fs.statSync(full).isFile()) {
        expect(fs.readFileSync(full, 'utf-8')).not.toContain('REGISTRATION-PRIVATE-KEY');
      }
    }
  });

  it('drops a key an earlier version left in the config dir, and never copies one from there', async () => {
    // Earlier versions copied all three files into config/<n>, and a legacy
    // registration saved its own there.
    write(path.join(runnerDir, 'config', '1', '.credentials_rsaparams'), JSON.stringify({ d: 'REGISTRATION-PRIVATE-KEY' }));
    write(path.join(runnerDir, 'config', '1', '.credentials'), '{}');

    const sandboxWithLegacy = await downloader.buildSandbox(1, version);
    expect(fs.existsSync(path.join(sandboxWithLegacy, '.credentials_rsaparams'))).toBe(false);
    expect(fs.existsSync(path.join(sandboxWithLegacy, '.credentials'))).toBe(false);

    await downloader.copyProxyCredentials(1, path.join(runnerDir, 'proxies', 'target-a'));
    expect(fs.existsSync(path.join(runnerDir, 'config', '1', '.credentials_rsaparams'))).toBe(false);
    expect(fs.existsSync(path.join(runnerDir, 'config', '1', '.credentials'))).toBe(false);
  });

  it('still requires the registration to be complete before a worker is built from it', async () => {
    fs.rmSync(path.join(runnerDir, 'proxies', 'target-a', '1', '.credentials_rsaparams'));
    await expect(downloader.copyProxyCredentials(1, path.join(runnerDir, 'proxies', 'target-a')))
      .rejects.toThrow('Missing proxy credential file');
  });
});

/**
 * The runner template under arc/ is copied into every worker. Anything that
 * could write it once - a `localmost test` run, before its profile stopped
 * granting ~/.localmost - would otherwise reach every later job.
 */
describe('the runner template a sandbox is copied from', () => {
  const version = '9.9.9';
  let root: string;
  let arc: string;
  let downloader: RunnerDownloader;
  let logged: string[];
  const savedConfigDir = process.env.LOCALMOST_CONFIG_DIR;
  const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;

  const write = (file: string, content: string, mode = 0o644) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode });
  };

  /** A runner release's layout in miniature, symlinks included. */
  const layOutRunner = (dir: string) => {
    write(path.join(dir, 'run.sh'), '#!/bin/bash\n', 0o755);
    write(path.join(dir, 'config.sh'), '#!/bin/bash\n', 0o755);
    write(path.join(dir, 'bin', 'Runner.Listener'), 'listener', 0o755);
    write(path.join(dir, 'bin', 'Runner.Worker.dll'), 'worker');
    write(path.join(dir, 'externals', 'node24', 'lib', 'npx-cli.js'), 'npx');
    write(path.join(dir, 'externals', 'node24', 'lib', 'npm-cli.js'), 'npm');
    fs.mkdirSync(path.join(dir, 'externals', 'node24', 'bin'), { recursive: true });
    fs.symlinkSync('../lib/npx-cli.js', path.join(dir, 'externals', 'node24', 'bin', 'npx'));
  };

  const build = () => downloader.buildSandbox(1, version, (_level, message) => logged.push(message));

  /** Serve a release: its API entry with the tarball's checksum, and the tarball. */
  const serveRelease = (tarball: Buffer, checksum = createHash('sha256').update(tarball).digest('hex')) => {
    const platform = `osx-${process.arch}`;
    mockFetch.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/')) {
        return { ok: true, json: async () => ({ body: `<!-- BEGIN SHA ${platform} -->${checksum}<!-- END SHA ${platform} -->` }) } as Response;
      }
      if (init?.method === 'HEAD') {
        return { ok: true, url, headers: new Headers({ 'content-length': String(tarball.length) }) } as Response;
      }
      let sent = false;
      const read = async () => {
        if (sent) return { done: true, value: undefined };
        sent = true;
        return { done: false, value: new Uint8Array(tarball) };
      };
      return { ok: true, body: { getReader: () => ({ read }) } } as unknown as Response;
    });
  };

  const tarballOf = async (dir: string): Promise<Buffer> => {
    const file = path.join(root, 'release.tar.gz');
    await tar.c({ gzip: true, file, cwd: dir, portable: true }, fs.readdirSync(dir));
    const tarball = fs.readFileSync(file);
    fs.rmSync(file);
    return tarball;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-arc-'));
    process.env.LOCALMOST_CONFIG_DIR = root;
    arc = path.join(root, 'runner', 'arc', `v${version}`);
    layOutRunner(arc);
    logged = [];
    downloader = new RunnerDownloader();
    downloader.setDownloadVersion(version);
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
    else process.env.LOCALMOST_CONFIG_DIR = savedConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('builds a sandbox from a template that matches its record', async () => {
    await downloader.recordArcManifest(version);

    const sandbox = await build();

    expect(fs.readFileSync(path.join(sandbox, 'bin', 'Runner.Listener'), 'utf-8')).toBe('listener');
    expect(fs.readlinkSync(path.join(sandbox, 'externals', 'node24', 'bin', 'npx'))).toBe('../lib/npx-cli.js');
  });

  it('refuses to build from a template file changed after it was recorded', async () => {
    await downloader.recordArcManifest(version);
    fs.writeFileSync(path.join(arc, 'bin', 'Runner.Worker.dll'), 'worker, and something else');

    await expect(build()).rejects.toThrow(/does not match/);
    expect(logged.join('\n')).toMatch(/bin\/Runner\.Worker\.dll/);
  });

  it('refuses a file added to the template', async () => {
    // The runner loads a .env beside it into its own environment.
    await downloader.recordArcManifest(version);
    write(path.join(arc, '.env'), 'DYLD_INSERT_LIBRARIES=/tmp/x.dylib\n');

    await expect(build()).rejects.toThrow(/does not match/);
    expect(logged.join('\n')).toMatch(/\.env/);
  });

  it('refuses a file removed from the template', async () => {
    await downloader.recordArcManifest(version);
    fs.rmSync(path.join(arc, 'config.sh'));

    await expect(build()).rejects.toThrow(/does not match/);
    expect(logged.join('\n')).toMatch(/config\.sh/);
  });

  it('refuses a symlink pointed somewhere else inside the template', async () => {
    await downloader.recordArcManifest(version);
    fs.rmSync(path.join(arc, 'externals', 'node24', 'bin', 'npx'));
    fs.symlinkSync('../lib/npm-cli.js', path.join(arc, 'externals', 'node24', 'bin', 'npx'));

    await expect(build()).rejects.toThrow(/does not match/);
    expect(logged.join('\n')).toMatch(/externals\/node24\/bin\/npx/);
  });

  it('records the release, not what is on disk, for a template installed before records were kept', async () => {
    // Recording whatever is on disk would bless a template already changed.
    // The release download is checked against GitHub's published checksum
    // and the record is built from that.
    const pristine = path.join(root, 'pristine');
    layOutRunner(pristine);
    serveRelease(await tarballOf(pristine));
    fs.rmSync(pristine, { recursive: true });
    fs.writeFileSync(path.join(arc, 'bin', 'Runner.Worker.dll'), 'tampered before the upgrade');

    await expect(build()).rejects.toThrow(/does not match/);
    expect(logged.join('\n')).toMatch(/bin\/Runner\.Worker\.dll/);

    // The record now exists, so a second start does not download again, and
    // a restored template passes.
    mockFetch.mockReset();
    fs.writeFileSync(path.join(arc, 'bin', 'Runner.Worker.dll'), 'worker');
    await expect(build()).resolves.toBeDefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('keeps no record, and builds nothing, when the release does not match its checksum', async () => {
    const pristine = path.join(root, 'pristine');
    layOutRunner(pristine);
    serveRelease(await tarballOf(pristine), 'f'.repeat(64));
    fs.rmSync(pristine, { recursive: true });

    await expect(build()).rejects.toThrow(/Checksum verification failed/);
    expect(fs.existsSync(path.join(root, 'runner', 'arc-manifests', `v${version}.json`))).toBe(false);
    // Nothing of the scratch download is left behind.
    expect(fs.readdirSync(path.join(root, 'runner'))).toEqual(['arc']);
  });

  it('records what it extracted when it downloads a runner', async () => {
    const pristine = path.join(root, 'pristine');
    layOutRunner(pristine);
    serveRelease(await tarballOf(pristine));
    fs.rmSync(pristine, { recursive: true });
    fs.rmSync(path.join(root, 'runner', 'arc'), { recursive: true });

    await downloader.download(() => undefined);
    mockFetch.mockReset();

    await expect(build()).resolves.toBeDefined();
    expect(mockFetch).not.toHaveBeenCalled();
    fs.writeFileSync(path.join(arc, 'run.sh'), '#!/bin/bash\necho changed\n');
    await expect(build()).rejects.toThrow(/does not match/);
  });
});
