/**
 * What the release build ships around the app code: the `localmost` command
 * the app installs, the update manifest a release carries, the entitlements
 * the app and its helpers are signed with, and the usage their Info.plist
 * files declare. Nothing here builds or signs anything; each piece is run or
 * loaded as the build would.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..', '..');

describe('the installed localmost command', () => {
  // The bundle holds the wrapper and cli.js side by side in Resources; the
  // app installs /usr/local/bin/localmost as a link to the wrapper.
  let scratch: string;
  let resources: string;
  let bin: string;

  const cliJs = (label: string) =>
    `process.stdout.write(JSON.stringify({ ran: ${JSON.stringify(label)}, args: process.argv.slice(2) }));\n`;

  // The node running these tests stands in for the user's.
  const env = () => ({ PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` });

  const run = (file: string, args: string[] = [], cwd = scratch, pathDirs: string[] = []) =>
    JSON.parse(
      execFileSync(file, args, {
        cwd,
        encoding: 'utf-8',
        env: { PATH: [...pathDirs, env().PATH].join(':') },
      }),
    );

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-cli-')));
    resources = path.join(scratch, 'localmost.app', 'Contents', 'Resources');
    fs.mkdirSync(resources, { recursive: true });
    fs.copyFileSync(path.join(REPO, 'scripts', 'localmost-cli'), path.join(resources, 'localmost-cli'));
    fs.chmodSync(path.join(resources, 'localmost-cli'), 0o755);
    fs.writeFileSync(path.join(resources, 'cli.js'), cliJs('bundled'));
    // A cli.js beside the link must never be the one that runs.
    bin = path.join(scratch, 'usr', 'local', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'cli.js'), cliJs('decoy'));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('runs the bundled cli.js through an absolute link, as the app installs it', () => {
    fs.symlinkSync(path.join(resources, 'localmost-cli'), path.join(bin, 'localmost'));

    expect(run(path.join(bin, 'localmost'), ['status', 'a b'])).toEqual({ ran: 'bundled', args: ['status', 'a b'] });
  });

  it('runs the bundled cli.js when found on PATH by name', () => {
    fs.symlinkSync(path.join(resources, 'localmost-cli'), path.join(bin, 'localmost'));

    expect(run('localmost', ['status'], scratch, [bin])).toEqual({ ran: 'bundled', args: ['status'] });
  });

  it.each(['/bin/sh', '/bin/bash'])(
    'runs the bundled cli.js when handed by name to %s, which finds it on PATH',
    (shell) => {
      fs.symlinkSync(path.join(resources, 'localmost-cli'), path.join(bin, 'localmost'));
      // The shell searches PATH for a script it cannot find in the working
      // directory, leaving $0 the bare name; a cli.js here must not run.
      const cwd = path.join(scratch, 'checkout');
      fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(cwd, 'cli.js'), cliJs('decoy'));

      expect(run(shell, ['localmost', 'status'], cwd, [bin])).toEqual({ ran: 'bundled', args: ['status'] });
    },
  );

  it('resolves a relative link against the directory holding the link', () => {
    fs.symlinkSync(path.relative(bin, path.join(resources, 'localmost-cli')), path.join(bin, 'localmost'));

    expect(run(path.join(bin, 'localmost'))).toEqual({ ran: 'bundled', args: [] });
    // Invoked by a relative path too, from the link's own directory.
    expect(run('./localmost', [], bin)).toEqual({ ran: 'bundled', args: [] });
  });

  it('follows a chain of links, each relative to its own directory', () => {
    // bin/localmost -> ../../../opt/localmost -> ../localmost.app/.../localmost-cli
    const opt = path.join(scratch, 'opt');
    fs.mkdirSync(opt);
    fs.writeFileSync(path.join(opt, 'cli.js'), cliJs('decoy'));
    fs.symlinkSync(path.relative(opt, path.join(resources, 'localmost-cli')), path.join(opt, 'localmost'));
    fs.symlinkSync(path.relative(bin, path.join(opt, 'localmost')), path.join(bin, 'localmost'));

    expect(run(path.join(bin, 'localmost'))).toEqual({ ran: 'bundled', args: [] });
  });

  it('gives up on a link loop instead of spinning', () => {
    fs.symlinkSync(path.join(resources, 'localmost-cli'), path.join(bin, 'localmost'));
    fs.symlinkSync('b', path.join(bin, 'a'));
    fs.symlinkSync('a', path.join(bin, 'b'));
    // Run the wrapper's own text with $0 set to the looping name: the kernel
    // would refuse to exec a loop, but a shell handed the name would not.
    let failure: unknown;
    try {
      execFileSync('/bin/sh', ['-c', fs.readFileSync(path.join(resources, 'localmost-cli'), 'utf-8'), path.join(bin, 'a')], {
        encoding: 'utf-8',
        env: env(),
        timeout: 10_000,
        stdio: 'pipe',
      });
    } catch (err) {
      failure = err;
    }
    expect(failure).toMatchObject({ status: 1 });
    expect(String((failure as { stderr: string }).stderr)).toMatch(/too many levels of symbolic links/);
  });
});

describe('the release update manifest', () => {
  // electron-updater's own code decides what a Mac downloads; load the real
  // functions rather than the mock the other tests map electron-updater to.
  const updaterOut = path.join(REPO, 'node_modules', 'electron-updater', 'out');
  const { findFile, resolveFiles } = require(path.join(updaterOut, 'providers', 'Provider'));
  const { MacUpdater } = require(path.join(updaterOut, 'MacUpdater'));
  const yaml = require(path.join(REPO, 'node_modules', 'js-yaml'));
  const version: string = require(path.join(REPO, 'package.json')).version;

  const GENERATOR = path.join(REPO, 'scripts', 'generate-latest-mac-yml.js');

  let makeDir: string;

  const sha512 = (file: string) =>
    crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');

  // Lay out what `npm run make` leaves for one arch: maker-dmg's image at
  // the top and maker-zip's archive under zip/darwin/<arch>.
  const make = (arch: string) => {
    fs.writeFileSync(path.join(makeDir, `localmost-${version}-${arch}.dmg`), `dmg ${arch}`);
    const zipDir = path.join(makeDir, 'zip', 'darwin', arch);
    fs.mkdirSync(zipDir, { recursive: true });
    fs.writeFileSync(path.join(zipDir, `localmost-darwin-${arch}-${version}.zip`), `zip ${arch} app`);
  };

  const generate = () =>
    execFileSync(process.execPath, [GENERATOR, makeDir], { encoding: 'utf-8', stdio: 'pipe' });

  const manifest = () => yaml.load(fs.readFileSync(path.join(makeDir, 'latest-mac.yml'), 'utf-8'));

  // The files a Mac's updater keeps from the manifest, as
  // MacUpdater.doDownloadUpdate filters them before it downloads anything.
  const filesFor = (isArm64Mac: boolean) => {
    const base = new URL(`https://github.com/bfulton/localmost/releases/download/v${version}/`);
    return MacUpdater.filterFilesForArch(resolveFiles(manifest(), base), isArm64Mac);
  };

  beforeEach(() => {
    makeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'latest-mac-')));
  });

  afterEach(() => {
    fs.rmSync(makeDir, { recursive: true, force: true });
  });

  it('offers an Apple silicon Mac the arm64 zip to download', () => {
    make('arm64');
    generate();

    expect(manifest().version).toBe(version);
    // What MacUpdater.doDownloadUpdate asks for before it downloads anything.
    const chosen = findFile(filesFor(true), 'zip', ['pkg', 'dmg']);

    expect(chosen).toBeTruthy();
    expect(chosen.info.url).toBe(`localmost-${version}-arm64-mac.zip`);
    // The release asset it names is in the make directory to attach, and is
    // maker-zip's archive, checksummed and sized as the updater verifies it.
    const asset = path.join(makeDir, chosen.info.url);
    expect(fs.readFileSync(asset, 'utf-8')).toBe('zip arm64 app');
    expect(chosen.info.sha512).toBe(sha512(asset));
    expect(chosen.info.size).toBe(fs.statSync(asset).size);
  });

  it('offers an Intel Mac no file, so its download fails without installing anything', () => {
    make('arm64');
    generate();

    // An Intel Mac keeps only the files not named arm64, which is none, and
    // the updater refuses to download from an empty list. It still reports
    // the version as available: that check reads only the version and the
    // minimum OS, not the files.
    const files = filesFor(false);
    expect(files).toEqual([]);
    expect(() => findFile(files, 'zip', ['pkg', 'dmg'])).toThrow(
      expect.objectContaining({ code: 'ERR_UPDATER_NO_FILES_PROVIDED' }),
    );
  });

  // What AppUpdater.isUpdateAvailable asks before it offers a version: it
  // compares os.release(), the Darwin version, with minimumSystemVersion.
  const supportedOn = (darwinRelease: string) => {
    const { AppUpdater } = require(path.join(updaterOut, 'AppUpdater'));
    const release = jest.spyOn(require('os'), 'release').mockReturnValue(darwinRelease);
    try {
      return AppUpdater.prototype.checkIfUpdateSupported.call(
        { _logger: { info: () => {}, warn: () => {} } },
        manifest(),
      );
    } finally {
      release.mockRestore();
    }
  };

  it.each([
    ['macOS 12.7', '21.6.0'],
    ['macOS 13.0', '22.1.0'],
    ['macOS 13.7', '22.6.0'],
  ])('offers no update to %s, which cannot open it', (_macos, darwin) => {
    make('arm64');
    generate();

    expect(supportedOn(darwin)).toBe(false);
  });

  it.each([
    ['macOS 14.0', '23.0.0'],
    ['macOS 15.6', '24.6.0'],
    ['macOS 26.6', '25.6.0'],
  ])('offers the update to %s', (_macos, darwin) => {
    make('arm64');
    generate();

    expect(supportedOn(darwin)).toBe(true);
  });

  it('lists only the arm64 zip and DMG', () => {
    make('arm64');
    generate();

    expect(manifest().files.map((f: { url: string }) => f.url)).toEqual([
      `localmost-${version}-arm64-mac.zip`,
      `localmost-${version}-arm64.dmg`,
    ]);
  });

  it('points the legacy path and sha512 at a zip', () => {
    make('arm64');
    generate();

    const info = manifest();
    expect(info.path).toBe(`localmost-${version}-arm64-mac.zip`);
    expect(info.sha512).toBe(sha512(path.join(makeDir, info.path)));
  });

  it('refuses a release without the arm64 build, which would leave every Mac without updates', () => {
    fs.writeFileSync(path.join(makeDir, `localmost-${version}-arm64.dmg`), 'dmg arm64');

    expect(generate).toThrow(/zip\/darwin\/arm64/);
    expect(fs.existsSync(path.join(makeDir, 'latest-mac.yml'))).toBe(false);
  });

  it.each([
    ['an Intel DMG', `localmost-${version}-x64.dmg`],
    ['an Intel zip', `zip/darwin/x64/localmost-darwin-x64-${version}.zip`],
    ['an Intel update zip', `localmost-${version}-x64-mac.zip`],
    ['a universal DMG', `localmost-${version}-universal.dmg`],
    ["an older release's DMG", 'localmost-0.2.0-arm64.dmg'],
  ])('refuses a make directory holding %s, so only this build is published', (_what, file) => {
    make('arm64');
    fs.mkdirSync(path.dirname(path.join(makeDir, file)), { recursive: true });
    fs.writeFileSync(path.join(makeDir, file), 'another build');

    expect(generate).toThrow(new RegExp(file.replace(/[.]/g, '\\.')));
    expect(fs.existsSync(path.join(makeDir, 'latest-mac.yml'))).toBe(false);
    expect(fs.existsSync(path.join(makeDir, `localmost-${version}-arm64-mac.zip`))).toBe(false);
  });
});

describe('the arch the app is built for', () => {
  const savedEnv = { ...process.env };
  let hooks: { prePackage: (config: object, platform: string, arch: string) => Promise<void> };
  let checkVmResources: jest.SpiedFunction<(paths: object) => void>;

  beforeEach(() => {
    // Load the config unsigned, without asking the keychain or git.
    process.env.APPLE_IDENTITY = '-';
    process.env.RELEASE_BUILD = 'false';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.isolateModules(() => {
      // The VM resources are checked on their own below; here they pass.
      checkVmResources = jest
        .spyOn(require(path.join(REPO, 'scripts', 'check-vm-resources.js')), 'checkVmResources')
        .mockImplementation(() => {});
      hooks = require(path.join(REPO, 'forge.config.js')).hooks;
    });
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.restoreAllMocks();
  });

  it('packages for Apple silicon', async () => {
    await expect(hooks.prePackage({}, 'darwin', 'arm64')).resolves.toBeUndefined();
  });

  it.each(['x64', 'universal', 'x64,arm64'])('refuses to package for %s', async (arch) => {
    await expect(hooks.prePackage({}, 'darwin', arch)).rejects.toThrow(
      `localmost is built for Apple silicon (arm64) only, not ${arch}`,
    );
    expect(checkVmResources).not.toHaveBeenCalled();
  });
});

describe('the Docker VM the app ships', () => {
  // The helper, the guest image and the docker CLI, which build:native puts
  // in build/ and packaging copies into Resources.
  const BUILD = path.join(REPO, 'build');
  const savedEnv = { ...process.env };
  let config: {
    packagerConfig: { extraResource: string[]; osxSign?: object };
    hooks: {
      generateAssets: (config: object, platform: string, arch: string) => Promise<void>;
      prePackage: (config: object, platform: string, arch: string) => Promise<void>;
    };
  };
  let checkVmResources: jest.SpiedFunction<(paths: object) => void>;

  const load = (identity: string) => {
    process.env.APPLE_IDENTITY = identity;
    process.env.RELEASE_BUILD = 'false';
    jest.isolateModules(() => {
      checkVmResources = jest
        .spyOn(require(path.join(REPO, 'scripts', 'check-vm-resources.js')), 'checkVmResources')
        .mockImplementation(() => {});
      config = require(path.join(REPO, 'forge.config.js'));
    });
  };

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    load('-');
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.restoreAllMocks();
  });

  it('copies the helper, the guest and the docker CLI into Resources', () => {
    expect(config.packagerConfig.extraResource).toEqual(
      expect.arrayContaining([
        path.join(BUILD, 'localmost-vm'),
        path.join(BUILD, 'guest'),
        path.join(BUILD, 'docker-cli'),
      ]),
    );
  });

  it('puts each where the app looks for it, packaged and in development', () => {
    // extraResource copies each path to Resources/<basename>.
    const { extraResource } = config.packagerConfig;
    const source = (name: string) => {
      const found = extraResource.filter((file) => path.basename(file) === name);
      expect(found).toHaveLength(1);
      return found[0];
    };
    const { app } = require('electron');
    const paths = require('./vm/paths');
    const savedResourcesPath = process.resourcesPath;
    const savedAppPath = app.getAppPath();
    try {
      app.isPackaged = true;
      Object.defineProperty(process, 'resourcesPath', { value: '/R', configurable: true });
      expect(paths.helperPath()).toBe(path.join('/R', path.basename(source('localmost-vm'))));
      expect(paths.guestDir()).toBe(path.join('/R', path.basename(source('guest'))));
      expect(paths.dockerCliPath()).toBe(path.join('/R', path.basename(source('docker-cli')), 'docker'));

      // Unpackaged, `electron .` on the checkout runs what packaging copies.
      app.isPackaged = false;
      delete process.env.LOCALMOST_VM_HELPER;
      app.getAppPath.mockReturnValue(REPO);
      expect(paths.helperPath()).toBe(source('localmost-vm'));
      expect(paths.guestDir()).toBe(source('guest'));
      expect(paths.dockerCliPath()).toBe(path.join(source('docker-cli'), 'docker'));
    } finally {
      app.isPackaged = false;
      app.getAppPath.mockReturnValue(savedAppPath);
      Object.defineProperty(process, 'resourcesPath', { value: savedResourcesPath, configurable: true });
    }
  });

  it('builds them before packaging, and fails when that fails', async () => {
    const childProcess = require('child_process');
    const spawnSync = jest.spyOn(childProcess, 'spawnSync').mockReturnValue({ status: 0 });

    await expect(config.hooks.generateAssets({}, 'darwin', 'arm64')).resolves.toBeUndefined();
    expect(spawnSync).toHaveBeenCalledWith('npm', ['run', 'build:native'], expect.objectContaining({ cwd: REPO }));
    // What that script runs; each step keeps its own cache.
    expect(require(path.join(REPO, 'package.json')).scripts['build:native']).toBe(
      'npm run build:helper && npm run build:guest && npm run fetch:docker-cli',
    );

    spawnSync.mockReturnValue({ status: 1 });
    await expect(config.hooks.generateAssets({}, 'darwin', 'arm64')).rejects.toThrow(/build:native/);
    spawnSync.mockReturnValue({ status: null, error: new Error('spawn npm ENOENT') });
    await expect(config.hooks.generateAssets({}, 'darwin', 'arm64')).rejects.toThrow(/ENOENT/);
  });

  it('checks the build/ copies before packaging them, and fails the build when they fail', async () => {
    await config.hooks.prePackage({}, 'darwin', 'arm64');
    expect(checkVmResources).toHaveBeenCalledWith({
      helper: path.join(BUILD, 'localmost-vm'),
      guestDir: path.join(BUILD, 'guest'),
      dockerCliDir: path.join(BUILD, 'docker-cli'),
    });

    checkVmResources.mockImplementation(() => {
      throw new Error('build/guest holds notes.txt');
    });
    await expect(config.hooks.prePackage({}, 'darwin', 'arm64')).rejects.toThrow('build/guest holds notes.txt');
  });

  it("leaves the guest image unsigned: it is the VM's data, not macOS code", async () => {
    load('Apple Development: Test (TEAMID1234)');
    const { createSignOpts } = require(path.join(REPO, 'node_modules', '@electron', 'packager', 'dist', 'mac'));
    const { walkAsync } = require(path.join(REPO, 'node_modules', '@electron', 'osx-sign', 'dist', 'cjs', 'util'));
    const { ignore } = createSignOpts(config.packagerConfig.osxSign, 'darwin', '/x.app', '0', true);
    expect(typeof ignore).toBe('function');

    // An app with a binary-looking file at each place to check, walked as
    // osx-sign walks it for the files it would sign.
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ignore-guest-')));
    try {
      const app = path.join(scratch, 'localmost.app');
      const binary = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
      const guest = [
        'Contents/Resources/guest/vmlinux',
        'Contents/Resources/guest/initramfs.cpio.gz',
        'Contents/Resources/guest/rootfs.erofs',
      ];
      const others = [
        'Contents/MacOS/localmost',
        'Contents/Resources/localmost-vm',
        'Contents/Resources/docker-cli/docker',
        'Contents/Resources/guestbook',
        'Contents/Resources/guest-tools/vzrun',
        'Contents/Resources/other/guest/vmlinux',
        'Contents/Frameworks/localmost Helper.app/Contents/Resources/guest/vmlinux',
        'Contents/Frameworks/localmost Helper.app/Contents/MacOS/localmost Helper',
      ];
      for (const file of [...guest, ...others]) {
        fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
        fs.writeFileSync(path.join(app, file), binary);
      }
      const walked: string[] = await walkAsync(path.join(app, 'Contents'));
      const rel = (list: string[]) => list.map((file) => path.relative(app, file)).sort();
      // Without the rule, osx-sign would sign all three guest files.
      expect(rel(walked)).toEqual(expect.arrayContaining(guest));

      const signed = walked.filter((file) => !ignore(file));

      expect(rel(signed)).toEqual([...others, 'Contents/Frameworks/localmost Helper.app'].sort());
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('the checks before the Docker VM is packaged', () => {
  const { checkVmResources, GUEST_FILES } = require(path.join(REPO, 'scripts', 'check-vm-resources.js'));

  // The header of a thin Mach-O executable for the given CPU and subtype
  // (arm64, CPU_SUBTYPE_ARM64_ALL, unless said otherwise).
  const machO = (cpuType = 0x0100000c, cpuSubtype = 0) => {
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(cpuType, 4);
    header.writeUInt32LE(cpuSubtype, 8);
    header.writeUInt32LE(2, 12);
    return header;
  };
  const INTEL = 0x01000007;
  // arm64e with the pointer-authentication ABI bit, as Apple's toolchain
  // writes it: third-party arm64e code does not run on a stock Mac.
  const ARM64E = [0x0100000c, 0x80000002] as const;
  const sha256 = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');

  let scratch: string;
  let paths: { helper: string; guestDir: string; dockerCliDir: string };
  const ARTIFACTS: Record<string, Buffer> = {
    vmlinux: Buffer.from('an arm64 Linux kernel image'),
    'initramfs.cpio.gz': Buffer.from('an initramfs'),
    'rootfs.erofs': Buffer.from('an erofs root'),
  };

  const manifestOf = (files: Record<string, Buffer>) =>
    Object.fromEntries(Object.entries(files).map(([name, data]) => [name, { sha256: sha256(data), size: data.length }]));
  const writeManifest = (artifacts: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    fs.writeFileSync(
      path.join(paths.guestDir, 'manifest.json'),
      JSON.stringify({ schema: 1, guestVersion: '2026.10.0', artifacts, ...extra }),
    );
  const moveAsideAndLink = (file: string) => {
    const aside = path.join(scratch, `real-${path.basename(file)}`);
    fs.renameSync(file, aside);
    fs.symlinkSync(aside, file);
  };

  // What build:native leaves in build/ when it succeeds.
  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-resources-')));
    paths = {
      helper: path.join(scratch, 'localmost-vm'),
      guestDir: path.join(scratch, 'guest'),
      dockerCliDir: path.join(scratch, 'docker-cli'),
    };
    fs.writeFileSync(paths.helper, machO(), { mode: 0o755 });
    fs.mkdirSync(paths.guestDir);
    for (const [name, data] of Object.entries(ARTIFACTS)) {
      fs.writeFileSync(path.join(paths.guestDir, name), data);
    }
    fs.writeFileSync(path.join(paths.guestDir, 'LICENSES.md'), '# Licenses\n');
    writeManifest(manifestOf(ARTIFACTS));
    fs.mkdirSync(paths.dockerCliDir);
    fs.writeFileSync(path.join(paths.dockerCliDir, 'docker'), machO(), { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('allows exactly the five guest files', () => {
    expect(GUEST_FILES).toEqual(['LICENSES.md', 'initramfs.cpio.gz', 'manifest.json', 'rootfs.erofs', 'vmlinux']);
  });

  it('passes what a successful build:native leaves', () => {
    expect(() => checkVmResources(paths)).not.toThrow();
  });

  it.each<[string, () => void, RegExp]>([
    ['a sixth file', () => fs.writeFileSync(path.join(paths.guestDir, 'notes.txt'), 'x'), /notes\.txt/],
    ["Finder's .DS_Store", () => fs.writeFileSync(path.join(paths.guestDir, '.DS_Store'), 'x'), /\.DS_Store/],
    ['a directory', () => fs.mkdirSync(path.join(paths.guestDir, 'extra')), /extra/],
    ['a missing file', () => fs.rmSync(path.join(paths.guestDir, 'LICENSES.md')), /LICENSES\.md/],
    ['a link in place of a file', () => moveAsideAndLink(path.join(paths.guestDir, 'vmlinux')), /vmlinux.*regular file/],
    ['a link in place of the directory', () => moveAsideAndLink(paths.guestDir), /guest.*directory/],
    [
      'an artifact that differs from the manifest',
      () => fs.appendFileSync(path.join(paths.guestDir, 'rootfs.erofs'), '!'),
      /rootfs\.erofs/,
    ],
    [
      'a manifest missing an artifact',
      () => writeManifest(manifestOf({ vmlinux: ARTIFACTS.vmlinux, 'rootfs.erofs': ARTIFACTS['rootfs.erofs'] })),
      /initramfs\.cpio\.gz/,
    ],
    [
      'a manifest naming another artifact',
      () => writeManifest({ ...manifestOf(ARTIFACTS), 'extra.img': { sha256: sha256(Buffer.alloc(0)), size: 0 } }),
      /extra\.img/,
    ],
    [
      'a manifest with a malformed hash',
      () => writeManifest({ ...manifestOf(ARTIFACTS), vmlinux: { sha256: 'abc', size: ARTIFACTS.vmlinux.length } }),
      /vmlinux/,
    ],
    [
      'a manifest with the right hash but the wrong size',
      () => writeManifest({ ...manifestOf(ARTIFACTS), vmlinux: { sha256: sha256(ARTIFACTS.vmlinux), size: 1 } }),
      /vmlinux/,
    ],
    ['a manifest of another schema', () => writeManifest(manifestOf(ARTIFACTS), { schema: 2 }), /schema/],
    ['an unreadable manifest', () => fs.writeFileSync(path.join(paths.guestDir, 'manifest.json'), '{'), /manifest\.json/],
  ])('refuses a build/guest with %s', (_what, change, error) => {
    change();
    expect(() => checkVmResources(paths)).toThrow(error);
  });

  it.each<[string, () => void, RegExp]>([
    ['missing', () => fs.rmSync(paths.helper), /localmost-vm/],
    ['not executable', () => fs.chmodSync(paths.helper, 0o644), /localmost-vm.*executable/],
    ['built for Intel', () => fs.writeFileSync(paths.helper, machO(INTEL)), /localmost-vm.*arm64/],
    ['built for arm64e', () => fs.writeFileSync(paths.helper, machO(...ARM64E)), /localmost-vm.*arm64/],
    ['a link', () => moveAsideAndLink(paths.helper), /localmost-vm.*regular file/],
  ])('refuses a helper that is %s', (_what, change, error) => {
    change();
    expect(() => checkVmResources(paths)).toThrow(error);
  });

  it.each<[string, () => void, RegExp]>([
    ['missing', () => fs.rmSync(path.join(paths.dockerCliDir, 'docker')), /docker/],
    ['not executable', () => fs.chmodSync(path.join(paths.dockerCliDir, 'docker'), 0o644), /docker.*executable/],
    ['built for Intel', () => fs.writeFileSync(path.join(paths.dockerCliDir, 'docker'), machO(INTEL)), /docker.*arm64/],
    ['built for arm64e', () => fs.writeFileSync(path.join(paths.dockerCliDir, 'docker'), machO(...ARM64E)), /docker.*arm64/],
    ['beside another file', () => fs.writeFileSync(path.join(paths.dockerCliDir, 'docker-compose'), 'x'), /docker-compose/],
  ])('refuses a docker CLI that is %s', (_what, change, error) => {
    change();
    expect(() => checkVmResources(paths)).toThrow(error);
  });

  it('names the command that builds them', () => {
    fs.rmSync(paths.guestDir, { recursive: true });
    expect(() => checkVmResources(paths)).toThrow(/npm run build:native/);
  });
});

describe('the macOS version the app requires', () => {
  const savedEnv = { ...process.env };
  let packagerConfig: { extendInfo?: Record<string, unknown> };

  beforeEach(() => {
    process.env.APPLE_IDENTITY = '-';
    process.env.RELEASE_BUILD = 'false';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.isolateModules(() => {
      packagerConfig = require(path.join(REPO, 'forge.config.js')).packagerConfig;
    });
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.restoreAllMocks();
  });

  it("is macOS 14, over Electron's own minimum", async () => {
    expect(packagerConfig.extendInfo).toEqual({ LSMinimumSystemVersion: '14.0' });
    // The update manifest's minimum comes from the same value.
    expect(require(path.join(REPO, 'scripts', 'macos-minimum.js')).MACOS_MINIMUM).toBe('14.0');
    // The installed packager's own merge, over the template's value.
    const { MacApp } = require(path.join(REPO, 'node_modules', '@electron', 'packager', 'dist', 'mac'));
    const template = { CFBundleExecutable: 'Electron', LSMinimumSystemVersion: '12.0' };
    const merged = await MacApp.prototype.extendPlist.call({}, { ...template }, packagerConfig.extendInfo);
    expect(merged).toEqual({ ...template, LSMinimumSystemVersion: '14.0' });
  });
});

describe('the Darwin version of a macOS release', () => {
  // electron-updater compares os.release(), which is the Darwin version.
  const darwinVersionOf = (macos: string) => require(path.join(REPO, 'scripts', 'macos-minimum.js')).darwinVersionOf(macos);

  it.each([
    ['11.0', '20.0.0'],
    ['14.0', '23.0.0'],
    ['15.0', '24.0.0'],
    // The year-numbered release after macOS 15.
    ['26.0', '25.0.0'],
  ])('maps macOS %s to Darwin %s', (macos, darwin) => {
    expect(darwinVersionOf(macos)).toBe(darwin);
  });

  // A point release's Darwin minor does not follow the macOS one (macOS 13.0
  // is Darwin 22.1), so only a major release can be a minimum.
  it.each(['14.1', '14', '10.15', '16.0', 'fourteen'])('refuses %s', (macos) => {
    expect(() => darwinVersionOf(macos)).toThrow(/macOS/);
  });
});

describe('the entitlements the app is signed with', () => {
  // Read a plist as codesign does, with the system's own parser.
  const readPlist = (file: string) =>
    JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf-8' }));

  const APP = path.join(REPO, 'build', 'out', 'localmost-darwin-arm64', 'localmost.app');
  const FRAMEWORKS = path.join(APP, 'Contents', 'Frameworks');

  // What the app and each helper carried before, less device and personal
  // information access: the hardened-runtime exceptions Electron needs.
  // (codesign -d --entitlements - on each executable of the 0.2.0 build.)
  const JIT = { 'com.apple.security.cs.allow-jit': true };
  const PLUGIN = {
    'com.apple.security.cs.allow-unsigned-executable-memory': true,
    'com.apple.security.cs.disable-library-validation': true,
  };
  const VIRTUALIZATION = { 'com.apple.security.virtualization': true };
  const EXPECTED: Array<[string, string, Record<string, boolean>]> = [
    ['the app', APP, JIT],
    ['the main helper', path.join(FRAMEWORKS, 'localmost Helper.app'), JIT],
    ['the GPU helper', path.join(FRAMEWORKS, 'localmost Helper (GPU).app'), JIT],
    ['the renderer helper', path.join(FRAMEWORKS, 'localmost Helper (Renderer).app'), JIT],
    ['the plugin helper', path.join(FRAMEWORKS, 'localmost Helper (Plugin).app'), PLUGIN],
    [
      'the plugin helper executable',
      path.join(FRAMEWORKS, 'localmost Helper (Plugin).app', 'Contents', 'MacOS', 'localmost Helper (Plugin)'),
      PLUGIN,
    ],
    ['ShipIt', path.join(FRAMEWORKS, 'Squirrel.framework', 'Versions', 'A', 'Resources', 'ShipIt'), JIT],
    ['the Electron framework', path.join(FRAMEWORKS, 'Electron Framework.framework'), JIT],
    // A Swift program that reads camera state; no JIT, no camera access.
    ['the camera helper', path.join(APP, 'Contents', 'Resources', 'is-camera-on'), {}],
    // The Docker VM helper: Virtualization.framework, and nothing else.
    ['the VM helper', path.join(APP, 'Contents', 'Resources', 'localmost-vm'), VIRTUALIZATION],
    // The docker CLI jobs run, a Go program: no exception at all.
    ['the docker CLI', path.join(APP, 'Contents', 'Resources', 'docker-cli', 'docker'), {}],
  ];

  type SignOptions = {
    optionsForFile?: (file: string) => { entitlements?: string; hardenedRuntime?: boolean } | null;
    continueOnError?: boolean;
  };

  let osxSign: SignOptions;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // Sign with a named identity, without asking the keychain or git.
    process.env.APPLE_IDENTITY = 'Apple Development: Test (TEAMID1234)';
    process.env.RELEASE_BUILD = 'false';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.isolateModules(() => {
      osxSign = require(path.join(REPO, 'forge.config.js')).packagerConfig.osxSign;
    });
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.restoreAllMocks();
  });

  it.each(EXPECTED)('signs %s with only the hardened-runtime exceptions it needs', (_what, file, expected) => {
    expect(typeof osxSign.optionsForFile).toBe('function');
    const options = osxSign.optionsForFile!(file);

    expect(options?.hardenedRuntime).toBe(true);
    const entitlements = readPlist(options!.entitlements!);
    expect(entitlements).toEqual(expected);
    // Stated outright: no device or personal information access, and never
    // the App Sandbox, which would stop the app running sandbox-exec. The
    // one key outside the hardened-runtime exceptions is the VM helper's.
    for (const key of Object.keys(entitlements)) {
      expect(key).toMatch(
        expected === VIRTUALIZATION ? /^com\.apple\.security\.virtualization$/ : /^com\.apple\.security\.cs\./,
      );
    }
  });

  it('gives Virtualization.framework to the VM helper in Resources and to nothing else', () => {
    const virtualization = path.join(REPO, 'packaging', 'entitlements.virtualization.plist');
    const plistFor = (file: string) => path.resolve(osxSign.optionsForFile!(file)!.entitlements!);
    expect(plistFor(path.join(APP, 'Contents', 'Resources', 'localmost-vm'))).toBe(virtualization);

    const elsewhere = [
      ...EXPECTED.filter(([what]) => what !== 'the VM helper').map(([, file]) => file),
      // The same name anywhere but the app's own Resources.
      path.join(APP, 'Contents', 'MacOS', 'localmost-vm'),
      path.join(APP, 'Contents', 'Resources', 'guest', 'localmost-vm'),
      path.join(APP, 'Contents', 'Resources', 'docker-cli', 'localmost-vm'),
      path.join(FRAMEWORKS, 'localmost Helper.app', 'Contents', 'Resources', 'localmost-vm'),
      path.join(FRAMEWORKS, 'localmost Helper.app', 'Contents', 'MacOS', 'localmost-vm'),
      path.join(FRAMEWORKS, 'Electron Framework.framework', 'Resources', 'localmost-vm'),
      // And names that merely contain it.
      path.join(APP, 'Contents', 'Resources', 'localmost-vm-old'),
      path.join(APP, 'Contents', 'Resources', 'not-localmost-vm'),
    ];
    for (const file of elsewhere) {
      expect([file, plistFor(file)]).not.toEqual([file, virtualization]);
    }
  });

  it('grants the VM helper exactly one entitlement', () => {
    const file = path.join(REPO, 'packaging', 'entitlements.virtualization.plist');
    expect(readPlist(file)).toEqual({ 'com.apple.security.virtualization': true });
    // plutil drops duplicates; the file itself names the key once.
    expect(fs.readFileSync(file, 'utf-8').match(/<key>/g)).toHaveLength(1);
  });

  it('fails the build when signing fails, rather than shipping it unsigned', () => {
    // @electron/packager treats an unset continueOnError as true: a failed
    // signApp becomes a warning and the build goes on with what is unsigned.
    expect(osxSign.continueOnError).toBe(false);
    // And the installed packager reads it that way, so a rename or a changed
    // default there cannot quietly turn signing failures back into warnings.
    const { createSignOpts } = require(path.join(REPO, 'node_modules', '@electron', 'packager', 'dist', 'mac'));
    expect(createSignOpts(osxSign, 'darwin', '/x.app', '0', true).continueOnError).toBe(false);
  });

  it('ships no entitlements file the signing does not use', () => {
    const used = new Set(EXPECTED.map(([, file]) => path.resolve(osxSign.optionsForFile!(file)!.entitlements!)));
    const shipped = fs
      .readdirSync(path.join(REPO, 'packaging'))
      .filter((name) => name.endsWith('.plist'))
      .map((name) => path.join(REPO, 'packaging', name));

    expect(shipped.sort()).toEqual([...used].sort());
  });
});

describe('the camera helper the app ships', () => {
  // osx-sign signs every Mach-O it finds in the bundle, Resources included,
  // with the per-file options checked above.
  const savedEnv = { ...process.env };
  let extraResource: string[];

  beforeEach(() => {
    process.env.APPLE_IDENTITY = '-';
    process.env.RELEASE_BUILD = 'false';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.isolateModules(() => {
      extraResource = require(path.join(REPO, 'forge.config.js')).packagerConfig.extraResource;
    });
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.restoreAllMocks();
  });

  it('copies the is-camera-on helper into Resources, under the name the app runs', () => {
    const { CAMERA_HELPER_NAME } = require('./resource-monitor/camera-helper');
    const helper = path.join(path.dirname(require.resolve('is-camera-on')), CAMERA_HELPER_NAME);

    // extraResource copies each path to Resources/<basename>.
    const shipped = extraResource.filter((file) => path.basename(file) === CAMERA_HELPER_NAME);
    expect(shipped.map((file) => fs.realpathSync(file))).toEqual([fs.realpathSync(helper)]);
    // A universal Mach-O, executable.
    const magic = fs.readFileSync(helper).subarray(0, 4).toString('hex');
    expect(magic).toBe('cafebabe');
    expect(fs.statSync(helper).mode & 0o111).not.toBe(0);
  });
});

describe('the usage descriptions the app declares', () => {
  // Electron's template app says why it would use the camera, microphone,
  // audio capture and Bluetooth. The app is signed without the entitlements
  // for any of them, so its Info.plist must not claim them either.
  const readPlist = (file: string) =>
    JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf-8' }));
  const { removeUsageDescriptions, USAGE_DESCRIPTION } = require(path.join(REPO, 'scripts', 'remove-usage-descriptions.js'));

  // The usage descriptions Electron's template app carries, and so what the
  // app ships unless something takes them out.
  const ELECTRON_USAGE = [
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
  ];
  const usageKeys = (plist: Record<string, unknown>) => Object.keys(plist).filter((key) => USAGE_DESCRIPTION.test(key));
  const withoutUsage = (plist: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(plist).filter(([key]) => !USAGE_DESCRIPTION.test(key)));

  const savedEnv = { ...process.env };
  let scratch: string;
  let staging: string;

  // A plist as packager writes one, in the format it writes, built here
  // rather than copied from node_modules/electron/dist: a CI job's install
  // does not always download Electron's app.
  const writePlist = (file: string, keys: Record<string, unknown>) => {
    fs.writeFileSync(file, JSON.stringify(keys));
    execFileSync('/usr/bin/plutil', ['-convert', 'xml1', file]);
  };

  // A packaged app's layout under root: the app's plist with the template's
  // usage descriptions among its other keys, and a helper's with one added,
  // as packager's usageDescription option would.
  const layOut = (root: string) => {
    const contents = path.join(root, 'localmost.app', 'Contents');
    fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
    writePlist(path.join(contents, 'Info.plist'), {
      CFBundleExecutable: 'localmost',
      CFBundleIdentifier: 'com.localmost.app',
      LSMinimumSystemVersion: '14.0',
      NSHighResolutionCapable: true,
      NSPrincipalClass: 'AtomApplication',
      ...Object.fromEntries(ELECTRON_USAGE.map((key) => [key, 'This app needs access to it.'])),
    });
    const helper = path.join(contents, 'Frameworks', 'localmost Helper.app', 'Contents');
    fs.mkdirSync(helper, { recursive: true });
    writePlist(path.join(helper, 'Info.plist'), {
      CFBundleIdentifier: 'com.localmost.app.helper',
      LSUIElement: true,
      NSCameraUsageDescription: 'x',
    });
    return { plist: path.join(contents, 'Info.plist'), helper: path.join(helper, 'Info.plist') };
  };

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-descriptions-')));
    staging = path.join(scratch, 'localmost-darwin-arm64');
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.restoreAllMocks();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("removes every usage description from the app's and its helpers' plists, and nothing else", () => {
    const { plist, helper } = layOut(staging);
    const before = readPlist(plist);
    const helperBefore = readPlist(helper);
    // The fixture does carry them; otherwise this would prove nothing.
    expect(usageKeys(before).sort()).toEqual(ELECTRON_USAGE);

    const removed: string[] = removeUsageDescriptions(staging);

    expect(readPlist(plist)).toEqual(withoutUsage(before));
    expect(readPlist(helper)).toEqual(withoutUsage(helperBefore));
    expect(removed).toHaveLength(ELECTRON_USAGE.length + 1);
  });

  it('leaves a plist reached through a link alone', () => {
    layOut(staging);
    const outside = path.join(scratch, 'outside');
    const { plist } = layOut(outside);
    fs.symlinkSync(path.join(outside, 'localmost.app'), path.join(staging, 'localmost.app', 'Contents', 'Linked.app'));
    const before = fs.readFileSync(plist);

    removeUsageDescriptions(staging);

    expect(fs.readFileSync(plist)).toEqual(before);
  });

  it('fails when there is no app to edit, rather than letting the strings ship', () => {
    fs.mkdirSync(staging);
    expect(() => removeUsageDescriptions(staging)).toThrow(/No app bundle/);
  });

  it('runs in the installed packager after the plists are written and before the app is signed', async () => {
    // A real MacApp from the installed @electron/packager, given the forge
    // config's packager options, with every step stubbed but the one that
    // runs the hook: copyExtraResources. The plist the signing step sees is
    // the one the signature covers.
    process.env.APPLE_IDENTITY = '-';
    process.env.RELEASE_BUILD = 'false';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    let packagerConfig: Record<string, unknown> = {};
    jest.isolateModules(() => {
      packagerConfig = require(path.join(REPO, 'forge.config.js')).packagerConfig;
    });
    // Packager runs the hook only when extraResource is set, so the config's
    // own list goes in: were it dropped, the hook would silently not run.
    // Only its entries a checkout has are kept; the build products among
    // them exist only after a build.
    const extraResource = packagerConfig.extraResource as string[];
    expect(Array.isArray(extraResource)).toBe(true);
    const present = extraResource.filter((file) => fs.existsSync(file));
    expect(present).toContain(path.join(REPO, 'scripts', 'localmost-cli'));

    const { MacApp } = require(path.join(REPO, 'node_modules', '@electron', 'packager', 'dist', 'mac'));
    const macApp = new MacApp(
      { ...packagerConfig, extraResource: present, platform: 'darwin', arch: 'arm64', out: scratch, tmpdir: false },
      path.join(scratch, 'template'),
    );
    const steps: string[] = [];
    let plist = '';
    let atSigning: Record<string, unknown> | undefined;
    const step = (name: string, run: () => void = () => {}) => async () => {
      steps.push(name);
      run();
    };
    Object.assign(macApp, {
      initialize: step('initialize'),
      // Where packager writes the plists: the template's keys and all.
      updatePlistFiles: step('updatePlistFiles', () => {
        plist = layOut(staging).plist;
      }),
      copyIcon: step('copyIcon'),
      renameElectron: step('renameElectron'),
      renameAppAndHelpers: step('renameAppAndHelpers'),
      signAppIfSpecified: step('sign', () => {
        atSigning = readPlist(plist);
      }),
      notarizeAppIfSpecified: step('notarize'),
      move: step('move'),
    });

    await macApp.create();

    expect(steps).toEqual([
      'initialize',
      'updatePlistFiles',
      'copyIcon',
      'renameElectron',
      'renameAppAndHelpers',
      'sign',
      'notarize',
      'move',
    ]);
    // copyExtraResources ran for real, and the hook after it.
    expect(fs.readFileSync(path.join(staging, 'localmost.app', 'Contents', 'Resources', 'localmost-cli'))).toEqual(
      fs.readFileSync(path.join(REPO, 'scripts', 'localmost-cli')),
    );
    expect(atSigning).toBeDefined();
    expect(usageKeys(atSigning!)).toEqual([]);
    expect(atSigning!.NSPrincipalClass).toBe('AtomApplication');
  });
});
