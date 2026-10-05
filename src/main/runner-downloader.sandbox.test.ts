import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';
import { RunnerDownloader } from './runner-downloader';
import { developerPythonSync } from '../shared/sandbox-reaper';

/**
 * Where on the device each file's first byte is stored, by fcntl
 * F_LOG2PHYS_EXT through the developer tools' python. Two files whose first
 * blocks are one block share it: an APFS clone, not a copy.
 */
const deviceOffsets = (...files: string[]): number[] => {
  const python = developerPythonSync();
  expect(python).not.toBeNull();
  const script = [
    'import fcntl, os, struct, sys',
    'for name in sys.argv[1:]:',
    '    fd = os.open(name, os.O_RDONLY)',
    // struct log2phys { u_int32_t flags; off_t contigbytes; off_t devoffset; }, packed to 4
    "    out = fcntl.fcntl(fd, 65, struct.pack('=Iqq', 0, 1 << 20, 0))",
    '    os.close(fd)',
    "    print(struct.unpack('=Iqq', out)[2])",
  ].join('\n');
  const output = execFileSync(python!, ['-c', script, ...files], { encoding: 'utf-8', timeout: 30000, env: { PATH: '/usr/bin:/bin' } });
  return output.trim().split('\n').map(Number);
};

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
    jest.restoreAllMocks();
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

  it('builds every start of a slot in a directory of its own', async () => {
    // A worker's profile grants its sandbox by path, and a process its job
    // started can outlive the worker. Built again at the same path, the next
    // job's runner, checkout and docker socket would be within its reach.
    await downloader.copyProxyCredentials(1, path.join(runnerDir, 'proxies', 'target-a'));
    const first = await downloader.buildSandbox(1, version);
    const second = await downloader.buildSandbox(1, version);

    expect(second).not.toBe(first);
    expect(second.startsWith(first + path.sep)).toBe(false);
    for (const sandbox of [first, second]) {
      expect(path.dirname(sandbox)).toBe(path.join(runnerDir, 'sandbox'));
      expect(path.basename(sandbox)).toMatch(/^1-/);
      // Each is the whole runner, checked against its record, with the
      // slot's settings.
      expect(fs.readFileSync(path.join(sandbox, 'bin', 'Runner.Listener'), 'utf-8')).toBe('listener');
      expect(fs.existsSync(path.join(sandbox, '.runner'))).toBe(true);
    }
  });

  it("copies the runner as a clone sharing the template's blocks, and still checks the copy", async () => {
    // A byte copy of the runner - nearly 500 MiB - into every sandbox took
    // seconds of every spawn and as much disk again for each running job. An
    // APFS clone shares the template's blocks until one side writes. Where
    // a file's first block lives on the device tells the two apart: a clone's
    // is the template's, a copy's is new. Real content, flushed, so the file
    // has blocks of its own to begin with.
    const arcFile = path.join(runnerDir, 'arc', `v${version}`, 'bin', 'libcoreclr.dylib');
    const fd = fs.openSync(arcFile, 'w', 0o755);
    fs.writeSync(fd, randomBytes(1024 * 1024));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    await downloader.recordArcManifest(version);
    const copyStarts = jest.spyOn(downloader as unknown as { compareWithManifest: () => Promise<string[]> }, 'compareWithManifest');

    const sandbox = await downloader.buildSandbox(1, version);

    const sandboxFile = path.join(sandbox, 'bin', 'libcoreclr.dylib');
    const [template, copy] = deviceOffsets(arcFile, sandboxFile);
    expect(copy).toBe(template);
    // Byte for byte the same, executable, and checked against the record.
    expect(fs.readFileSync(sandboxFile).equals(fs.readFileSync(arcFile))).toBe(true);
    expect(fs.statSync(sandboxFile).mode & 0o111).not.toBe(0);
    expect(copyStarts).toHaveBeenCalledWith(sandbox, expect.anything());
  });

  it("makes the work folder, the Docker VM's share, itself, empty, and no seatbelt job's home or docker config", async () => {
    // The share must be the directory localmost made, before anything runs in
    // the sandbox: made by the runner, it would be whatever the job left at
    // the name. A job's home and its CLI's config are its macOS VM's now.
    await downloader.copyProxyCredentials(1, path.join(runnerDir, 'proxies', 'target-a'));
    const sandbox = await downloader.buildSandbox(1, version);

    const stat = fs.lstatSync(path.join(sandbox, '_work'));
    expect([stat.isDirectory(), stat.isSymbolicLink()]).toEqual([true, false]);
    expect(fs.readdirSync(path.join(sandbox, '_work'))).toEqual([]);
    expect(fs.existsSync(path.join(sandbox, 'home'))).toBe(false);
    expect(fs.existsSync(path.join(sandbox, '.docker'))).toBe(false);
  });

  it('makes it with a plain mkdir, which refuses a name that already exists, before copying the runner', async () => {
    await downloader.copyProxyCredentials(1, path.join(runnerDir, 'proxies', 'target-a'));
    const made: Array<{ dir: string; recursive: boolean; afterCopy: boolean }> = [];
    let copied = false;
    const realCopy = downloader.copyVerifiedArc.bind(downloader);
    jest.spyOn(downloader, 'copyVerifiedArc').mockImplementation(async (...args) => {
      await realCopy(...args);
      copied = true;
    });
    const realMkdir = fs.promises.mkdir.bind(fs.promises);
    jest.spyOn(fs.promises, 'mkdir').mockImplementation((async (dir: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      made.push({ dir: String(dir), recursive: options?.recursive === true, afterCopy: copied });
      return realMkdir(dir, options);
    }) as never);

    const sandbox = await downloader.buildSandbox(1, version);

    expect(made.filter((m) => m.dir === path.join(sandbox, '_work'))).toEqual([
      { dir: path.join(sandbox, '_work'), recursive: false, afterCopy: false },
    ]);
  });

  it('builds no sandbox when the work folder cannot be made fresh', async () => {
    await downloader.copyProxyCredentials(1, path.join(runnerDir, 'proxies', 'target-a'));
    const realMkdir = fs.promises.mkdir.bind(fs.promises);
    jest.spyOn(fs.promises, 'mkdir').mockImplementation((async (dir: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (path.basename(String(dir)) === '_work') {
        throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${String(dir)}'`), { code: 'EEXIST' });
      }
      return realMkdir(dir, options);
    }) as never);

    await expect(downloader.buildSandbox(1, version)).rejects.toThrow(/EEXIST/);
    expect(fs.readdirSync(downloader.getSandboxBase())).toEqual([]);
  });

  describe("the share's nonce", () => {
    let sandbox: string;
    const noncePath = () => path.join(sandbox, '_work', '.localmost-share');

    beforeEach(async () => {
      await downloader.copyProxyCredentials(1, path.join(runnerDir, 'proxies', 'target-a'));
      sandbox = await downloader.buildSandbox(1, version);
    });

    it('is 32 hex, written where the guest reads it, readable by the app alone', () => {
      const nonce = downloader.writeShareNonce(sandbox);
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(fs.readFileSync(noncePath(), 'utf-8')).toBe(nonce);
      expect(fs.statSync(noncePath()).mode & 0o777).toBe(0o600);
      // A fresh one every time: a job cannot learn a later sandbox's nonce.
      const other = fs.mkdtempSync(path.join(root, 'other-'));
      fs.mkdirSync(path.join(other, '_work'));
      expect(downloader.writeShareNonce(other)).not.toBe(nonce);
    });

    it('is never written over a file already there', () => {
      fs.writeFileSync(noncePath(), 'planted');
      expect(() => downloader.writeShareNonce(sandbox)).toThrow(/EEXIST/);
      expect(fs.readFileSync(noncePath(), 'utf-8')).toBe('planted');
    });

    it('is never written through a link, dangling or not', () => {
      const target = path.join(root, 'victim');
      fs.writeFileSync(target, 'kept');
      fs.symlinkSync(target, noncePath());
      expect(() => downloader.writeShareNonce(sandbox)).toThrow(/EEXIST/);
      expect(fs.readFileSync(target, 'utf-8')).toBe('kept');

      fs.rmSync(noncePath());
      const missing = path.join(root, 'missing');
      fs.symlinkSync(missing, noncePath());
      expect(() => downloader.writeShareNonce(sandbox)).toThrow(/EEXIST/);
      expect(fs.existsSync(missing)).toBe(false);
    });
  });

  it('removes a sandbox it built, and refuses anything that is not one', async () => {
    await downloader.copyProxyCredentials(1, path.join(runnerDir, 'proxies', 'target-a'));
    const sandbox = await downloader.buildSandbox(1, version);
    const other = await downloader.buildSandbox(2, version);
    // Named like a sandbox, but not in the sandbox directory.
    const lookalike = path.join(runnerDir, 'config', '1-abc');
    write(path.join(lookalike, 'keep'), 'kept');

    await downloader.removeSandbox(sandbox);

    expect(fs.existsSync(sandbox)).toBe(false);
    expect(fs.existsSync(path.join(other, 'run.sh'))).toBe(true);
    for (const notASandbox of [
      path.join(runnerDir, 'sandbox'),
      path.join(runnerDir, 'config', '1'),
      path.join(runnerDir, 'arc', `v${version}`),
      path.join(other, '_work'),
      `${other}/../../config`,
      lookalike,
    ]) {
      await expect(downloader.removeSandbox(notASandbox)).rejects.toThrow(/not a sandbox/);
    }
    expect(fs.existsSync(path.join(runnerDir, 'config', '1', '.runner'))).toBe(true);
    expect(fs.existsSync(path.join(runnerDir, 'arc', `v${version}`, 'run.sh'))).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(path.join(lookalike, 'keep'))).toBe(true);
  });

  it('moves a sandbox out of its path before removing it', async () => {
    // A process its job left running can still write the sandbox's path, so
    // it could swap a directory in the tree for a link while a removal walks
    // it. Removed from a path no job's profile grants, the tree is out of its
    // reach - and removed without walking it by path, so that a writer no
    // profile confines cannot steer the removal either.
    await downloader.copyProxyCredentials(1, path.join(runnerDir, 'proxies', 'target-a'));
    const sandbox = await downloader.buildSandbox(1, version);
    write(path.join(sandbox, '_work', 'repo', 'src', 'output'), 'job');
    const base = downloader.getSandboxBase();
    const calls: Array<{ op: string; paths: string[] }> = [];
    for (const op of ['rename', 'rm', 'readdir', 'opendir', 'lstat', 'stat', 'unlink', 'rmdir'] as const) {
      const real = fs.promises[op].bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
      jest.spyOn(fs.promises, op).mockImplementation(((...args: unknown[]) => {
        calls.push({ op, paths: args.filter((arg): arg is string => typeof arg === 'string') });
        return real(...args);
      }) as never);
    }

    await downloader.removeSandbox(sandbox);

    const [first, ...rest] = calls;
    expect(first.op).toBe('rename');
    const [from, to] = first.paths;
    expect(from).toBe(sandbox);
    // Beside it, where only the app writes, and under a name no sandbox is
    // built with, so no job's profile grants it.
    expect(path.dirname(to)).toBe(base);
    expect(path.basename(to).startsWith('.removing-')).toBe(true);
    // From there, no path more than one entry below a directory named for
    // removal in the base, so no link swapped in anywhere is followed.
    for (const { op, paths } of rest) {
      expect(op).not.toBe('rm');
      for (const p of paths) {
        const rel = path.relative(base, p).split(path.sep);
        expect(rel[0].startsWith('.removing-')).toBe(true);
        expect(rel.length).toBeLessThanOrEqual(2);
      }
    }
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('never removes a sandbox where it is when it cannot be moved out of its path', async () => {
    await downloader.copyProxyCredentials(1, path.join(runnerDir, 'proxies', 'target-a'));
    const sandbox = await downloader.buildSandbox(1, version);
    jest.spyOn(fs.promises, 'rename').mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    );
    const removals = ['rm', 'unlink', 'rmdir'].map((op) => jest.spyOn(fs.promises, op as 'rm'));

    await expect(downloader.removeSandbox(sandbox)).rejects.toThrow(/EACCES/);

    // Left for the next startup's sweep, which moves it first too.
    for (const removal of removals) expect(removal).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(sandbox, 'run.sh'))).toBe(true);
  });

  it('removes a sandbox without following a link planted at or in it', async () => {
    const victim = path.join(root, 'victim');
    write(path.join(victim, 'keep'), 'kept');
    await downloader.copyProxyCredentials(1, path.join(runnerDir, 'proxies', 'target-a'));
    const linkedFrom = await downloader.buildSandbox(1, version);
    const replaced = await downloader.buildSandbox(2, version);
    // Its job can write anywhere in its sandbox, and can replace the
    // sandbox's own directory, since its profile grants that path.
    fs.symlinkSync(victim, path.join(linkedFrom, '_work', 'link'));
    fs.rmSync(replaced, { recursive: true, force: true });
    fs.symlinkSync(victim, replaced);

    await downloader.removeSandbox(linkedFrom);
    await downloader.removeSandbox(replaced);

    expect(fs.readFileSync(path.join(victim, 'keep'), 'utf-8')).toBe('kept');
    expect(fs.readdirSync(downloader.getSandboxBase())).toEqual([]);
  });

  it('never builds into a directory that is already there', async () => {
    // Whatever an earlier start left at the name it picks - or anything
    // put there - is refused, not built into and handed to the next job.
    await downloader.copyProxyCredentials(1, path.join(runnerDir, 'proxies', 'target-a'));
    const id = Buffer.from('0123456789ab', 'hex');
    // The module itself, which the downloader's import reads through.
    jest.spyOn(jest.requireActual<typeof import('crypto')>('crypto'), 'randomBytes').mockImplementation((() => id) as never);
    const taken = path.join(runnerDir, 'sandbox', `1-${id.toString('hex')}`);
    write(path.join(taken, 'left'), 'left');

    try {
      await expect(downloader.buildSandbox(1, version)).rejects.toThrow(/EEXIST/);
    } finally {
      jest.restoreAllMocks();
    }
    expect(fs.readdirSync(taken)).toEqual(['left']);
  });

  it("gives every job a _work of its own, never one kept from an earlier job's", async () => {
    // The removed preserveWorkDir setting linked _work to runner/work/<n>,
    // which outlived the sandbox and was handed to whatever job - from
    // whatever repository - next took that slot. A caller still passing the
    // option must get the same fresh sandbox as any other.
    const buildWithOption = downloader.buildSandbox as (...args: unknown[]) => Promise<string>;
    const sandbox = await buildWithOption.call(downloader, 1, version, undefined, { preserveWorkDir: true });

    const work = path.join(sandbox, '_work');
    expect(fs.existsSync(work) && fs.lstatSync(work).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(runnerDir, 'work'))).toBe(false);
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
  // The downloader fetches only the arm64 runner and refuses on any other
  // arch; run as an Apple silicon Mac whatever the host.
  const realArch = process.arch;
  const runningOn = (arch: string) => Object.defineProperty(process, 'arch', { value: arch });

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
    const platform = 'osx-arm64';
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
    runningOn('arm64');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-arc-'));
    process.env.LOCALMOST_CONFIG_DIR = root;
    arc = path.join(root, 'runner', 'arc', `v${version}`);
    layOutRunner(arc);
    logged = [];
    downloader = new RunnerDownloader();
    downloader.setDownloadVersion(version);
  });

  afterEach(() => {
    runningOn(realArch);
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
    // Deleting only this version would leave any older one there to be used,
    // so the remedy names the whole arc directory.
    expect(logged.join('\n')).toContain(`delete ${path.join(root, 'runner', 'arc')},`);
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

  it.each([
    ['an absolute link', (dir: string) => fs.symlinkSync('/etc/passwd', path.join(dir, 'bin', 'passwd')), /Absolute symlink/],
    ['a link out of the template', (dir: string) => fs.symlinkSync('../../../..', path.join(dir, 'bin', 'up')), /Symlink escapes/],
    ['a FIFO', (dir: string) => execFileSync('/usr/bin/mkfifo', [path.join(dir, 'bin', 'pipe')]), /Not a file, directory or link/],
  ])('refuses a template holding %s, even one recorded with it, and builds nothing', async (_name, plant, refusal) => {
    // The record lists files and links; it cannot vouch for a link's
    // destination or see a FIFO, so the copy is checked for those itself.
    plant(arc);
    await downloader.recordArcManifest(version);

    await expect(build()).rejects.toThrow(refusal);
    expect(fs.readdirSync(path.join(root, 'runner', 'sandbox'))).toEqual([]);
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
    // Nothing of the scratch download is left behind, nor the sandbox the
    // build had started.
    expect(fs.readdirSync(path.join(root, 'runner')).sort()).toEqual(['arc', 'sandbox']);
    expect(fs.readdirSync(path.join(root, 'runner', 'sandbox'))).toEqual([]);
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

  it('replaces a template it downloads again, rather than extracting over what is there', async () => {
    // Removing run.sh is enough for the app to offer the download again. A
    // file planted beside it must not survive into the new template - nor
    // into the record made from it, which would bless it for every worker.
    const pristine = path.join(root, 'pristine');
    layOutRunner(pristine);
    serveRelease(await tarballOf(pristine));
    fs.rmSync(pristine, { recursive: true });
    fs.rmSync(path.join(arc, 'run.sh'));
    write(path.join(arc, '.env'), 'DYLD_INSERT_LIBRARIES=/tmp/x.dylib\n');

    await downloader.download(() => undefined);

    expect(fs.existsSync(path.join(arc, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(arc, 'run.sh'))).toBe(true);
    const sandbox = await build();
    expect(fs.existsSync(path.join(sandbox, '.env'))).toBe(false);
    // Nothing of the download is left beside the template.
    expect(fs.readdirSync(path.join(root, 'runner')).sort()).toEqual(['arc', 'arc-manifests', 'sandbox']);
    expect(fs.readdirSync(path.join(root, 'runner', 'arc'))).toEqual([`v${version}`]);
  });

  it('sweeps a download a quit interrupted at the next startup', async () => {
    const leftover = path.join(root, 'runner', 'arc-staging-a1b2c3');
    write(path.join(leftover, 'tree', 'run.sh'), '#!/bin/bash\n');
    write(path.join(leftover, 'actions-runner-osx-arm64-9.9.9.tar.gz'), 'partial');

    await downloader.cleanupStaleConfiguration(() => undefined);

    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.existsSync(arc)).toBe(true);
  });

  it('sweeps a registration a quit interrupted at the next startup', async () => {
    // config.sh runs in a copy of the runner and leaves the registration's
    // key there; a quit before it is copied out leaves both behind.
    const leftover = path.join(root, 'runner', 'temp-proxy-a1b2c3');
    layOutRunner(leftover);
    write(path.join(leftover, '.credentials_rsaparams'), JSON.stringify({ d: 'REGISTRATION-PRIVATE-KEY' }), 0o600);

    await downloader.cleanupStaleConfiguration(() => undefined);

    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.existsSync(arc)).toBe(true);
  });

  it('gives each registration a directory of its own that only the app can open', async () => {
    const dirs = await Promise.all(Array.from({ length: 4 }, () => downloader.makeRegistrationDir()));

    expect(new Set(dirs).size).toBe(dirs.length);
    for (const dir of dirs) {
      expect(path.dirname(dir)).toBe(path.join(root, 'runner'));
      expect(path.basename(dir)).toMatch(/^temp-proxy-/);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it('leaves a registration still in progress alone when it sweeps', async () => {
    const dir = await downloader.makeRegistrationDir();
    write(path.join(dir, '.credentials_rsaparams'), JSON.stringify({ d: 'REGISTRATION-PRIVATE-KEY' }), 0o600);

    await downloader.cleanupStaleConfiguration(() => undefined);

    expect(fs.existsSync(path.join(dir, '.credentials_rsaparams'))).toBe(true);
    await downloader.removeRegistrationDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('leaves a registration another downloader started alone when it sweeps', async () => {
    // The app builds more than one downloader: the one that sweeps at
    // startup is not the only one that makes staging directories.
    const other = new RunnerDownloader();
    const dir = await other.makeRegistrationDir();

    await downloader.cleanupStaleConfiguration(() => undefined);

    expect(fs.existsSync(dir)).toBe(true);
    await downloader.removeRegistrationDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('stops counting the directory an integrity record was built in as in use once it is removed', async () => {
    const pristine = path.join(root, 'pristine');
    layOutRunner(pristine);
    serveRelease(await tarballOf(pristine));
    fs.rmSync(pristine, { recursive: true });
    const mkdtemp = jest.spyOn(fs.promises, 'mkdtemp');
    let made: string[];
    try {
      await build();
      made = await Promise.all(mkdtemp.mock.results.map((result) => result.value as Promise<string>));
    } finally {
      mkdtemp.mockRestore();
    }
    const scratch = made.filter((dir) => path.basename(dir).startsWith('arc-staging-'));
    expect(scratch).toHaveLength(1);
    expect(fs.existsSync(scratch[0])).toBe(false);

    // A quit leaving one of that name behind later is swept like any other.
    write(path.join(scratch[0], 'tree', 'run.sh'), '#!/bin/bash\n');
    await downloader.cleanupStaleConfiguration(() => undefined);
    expect(fs.existsSync(scratch[0])).toBe(false);
  });

  it('removes only a directory it made for a registration', async () => {
    const dir = await downloader.makeRegistrationDir();
    await downloader.removeRegistrationDir(dir);

    // Once released, the same path is no longer one of its own.
    await expect(downloader.removeRegistrationDir(dir)).rejects.toThrow(/Refusing/);
    await expect(downloader.removeRegistrationDir(arc)).rejects.toThrow(/Refusing/);
    expect(fs.existsSync(arc)).toBe(true);
  });

  it('sweeps the _work an earlier build kept for later jobs at the next startup', async () => {
    // An install that had the removed preserveWorkDir setting on still holds
    // an earlier job's checkout, from any repository, under runner/work.
    const kept = path.join(root, 'runner', 'work', '1');
    write(path.join(kept, 'other-repo', 'package.json'), '{}');

    await downloader.cleanupStaleConfiguration(() => undefined);

    // The sweep renames each directory aside before deleting it in the
    // background, so what matters is that nothing is left under its name.
    expect(fs.existsSync(kept)).toBe(false);
  });

  it('records the same version from two places at once without either failing', async () => {
    // A download and a worker's first start can both write a version's record.
    await expect(Promise.all(
      Array.from({ length: 8 }, () => downloader.recordArcManifest(version))
    )).resolves.toBeDefined();
    await expect(build()).resolves.toBeDefined();
    expect(fs.readdirSync(path.join(root, 'runner', 'arc-manifests'))).toEqual([`v${version}.json`]);
  });

  it('leaves the installed template as it was when a download fails', async () => {
    const pristine = path.join(root, 'pristine');
    layOutRunner(pristine);
    serveRelease(await tarballOf(pristine), 'f'.repeat(64));
    fs.rmSync(pristine, { recursive: true });
    await downloader.recordArcManifest(version);

    await expect(downloader.download(() => undefined)).rejects.toThrow(/Checksum verification failed/);

    await expect(build()).resolves.toBeDefined();
    expect(fs.readdirSync(path.join(root, 'runner', 'arc'))).toEqual([`v${version}`]);
  });
});
