/**
 * What the release build ships around the app code: the `localmost` command
 * the app installs, the update manifest a release carries, and the
 * entitlements the app and its helpers are signed with. Nothing here builds
 * or signs anything; each piece is run or loaded as the build would.
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
  const ARCHES = ['arm64', 'x64'] as const;

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

  beforeEach(() => {
    makeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'latest-mac-')));
  });

  afterEach(() => {
    fs.rmSync(makeDir, { recursive: true, force: true });
  });

  it.each([
    ['an arm64 Mac', true, 'arm64'],
    ['an Intel Mac', false, 'x64'],
  ])('offers %s a zip of its own arch to download', (_mac, isArm64Mac, arch) => {
    ARCHES.forEach(make);
    generate();

    const info = yaml.load(fs.readFileSync(path.join(makeDir, 'latest-mac.yml'), 'utf-8'));
    expect(info.version).toBe(version);
    const base = new URL(`https://github.com/bfulton/localmost/releases/download/v${version}/`);
    const files = MacUpdater.filterFilesForArch(resolveFiles(info, base), isArm64Mac);
    // What MacUpdater.doDownloadUpdate asks for before it downloads anything.
    const chosen = findFile(files, 'zip', ['pkg', 'dmg']);

    expect(chosen).toBeTruthy();
    expect(chosen.info.url).toBe(`localmost-${version}-${arch}-mac.zip`);
    // The release asset it names is in the make directory to attach, and is
    // maker-zip's archive, checksummed and sized as the updater verifies it.
    const asset = path.join(makeDir, chosen.info.url);
    expect(fs.readFileSync(asset, 'utf-8')).toBe(`zip ${arch} app`);
    expect(chosen.info.sha512).toBe(sha512(asset));
    expect(chosen.info.size).toBe(fs.statSync(asset).size);
  });

  it('points the legacy path and sha512 at a zip', () => {
    ARCHES.forEach(make);
    generate();

    const info = yaml.load(fs.readFileSync(path.join(makeDir, 'latest-mac.yml'), 'utf-8'));
    expect(info.path).toMatch(/-mac\.zip$/);
    expect(info.sha512).toBe(sha512(path.join(makeDir, info.path)));
  });

  it('refuses a release missing either arch, which would leave those Macs without updates', () => {
    make('arm64');

    expect(generate).toThrow(/x64/);
    expect(fs.existsSync(path.join(makeDir, 'latest-mac.yml'))).toBe(false);
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
    // the App Sandbox, which would stop the app running sandbox-exec.
    for (const key of Object.keys(entitlements)) {
      expect(key).toMatch(/^com\.apple\.security\.cs\./);
    }
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
