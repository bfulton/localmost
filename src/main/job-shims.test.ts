import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JOB_BIN_DIR, JOB_BIN_MODE, writeJobBin } from './job-shims';

describe("a job's own bin directory", () => {
  let root: string;
  let sandbox: string;
  let stubs: string;
  let dockerCli: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-job-bin-')));
    sandbox = path.join(root, 'sandbox', '1-0123456789ab');
    stubs = path.join(root, 'stubs');
    fs.mkdirSync(sandbox, { recursive: true });
    fs.mkdirSync(stubs);
    // The real tools, as far as the shims can tell: each prints the
    // arguments it was given, one to a line.
    for (const tool of ['swift', 'xcodebuild']) {
      fs.writeFileSync(path.join(stubs, tool), `#!/bin/sh\necho "${tool}"\nfor a in "$@"; do echo "$a"; done\n`, { mode: 0o755 });
    }
    dockerCli = path.join(root, 'Resources', 'docker-cli', 'docker');
    fs.mkdirSync(path.dirname(dockerCli), { recursive: true });
    fs.writeFileSync(dockerCli, '#!/bin/sh\necho docker\n', { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Run a tool from the bin directory, first on PATH as in a job, and return what reached the real one. */
  const call = (bin: string, tool: string, args: string[], pathDirs = [bin, stubs]) => {
    const result = spawnSync(path.join(bin, tool), args, { encoding: 'utf-8', env: { PATH: pathDirs.join(':') }, timeout: 15000 });
    return { status: result.status, argv: result.stdout.split('\n').slice(0, -1), stderr: result.stderr };
  };

  it('is <sandbox>/localmost/bin, with the shims and the bundled docker CLI', () => {
    const bin = writeJobBin(sandbox, { dockerCli, shims: true });

    expect(bin).toBe(path.join(sandbox, JOB_BIN_DIR));
    expect(JOB_BIN_DIR).toBe(path.join('localmost', 'bin'));
    expect(fs.readdirSync(bin).sort()).toEqual(['docker', 'swift', 'xcodebuild']);
    expect(fs.readlinkSync(path.join(bin, 'docker'))).toBe(dockerCli);
  });

  // The app sets umask 077; a test, or anything else calling writeJobBin, has
  // whatever umask its process has. The modes are the same whichever it is.
  // 177 and 777 clear owner bits, so they are the cases that need the
  // explicit chmod and fchmod: without them 177 leaves the shims unrunnable
  // and 777 leaves the directories and shims mode 0000.
  const umasks = [0o077, 0o022, 0o000, 0o177, 0o777].map((umask) => [umask.toString(8).padStart(3, '0'), umask] as const);
  it.each(umasks)('is the user\'s alone, directories and shims, under umask %s', (_label, umask) => {
    expect(JOB_BIN_MODE).toBe(0o700);
    const previous = process.umask(umask);
    let bin: string;
    try {
      bin = writeJobBin(sandbox, { dockerCli, shims: true });
    } finally {
      process.umask(previous);
    }
    const mode = (p: string) => fs.lstatSync(p).mode & 0o7777;
    expect([path.dirname(bin), bin].map(mode)).toEqual([0o700, 0o700]);
    expect(['swift', 'xcodebuild'].map((shim) => mode(path.join(bin, shim)))).toEqual([0o700, 0o700]);
    // Runnable as it is, by the job.
    expect(call(bin, 'swift', ['build'])).toEqual({ status: 0, argv: ['swift', 'build', '--disable-sandbox'], stderr: '' });
  });

  it('holds only the docker CLI with the shims turned off', () => {
    const bin = writeJobBin(sandbox, { dockerCli, shims: false });
    expect(fs.readdirSync(bin)).toEqual(['docker']);
  });

  it('is made fresh, never through anything already at the name', () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(sandbox, 'localmost'));
    expect(() => writeJobBin(sandbox, { dockerCli, shims: true })).toThrow(/EEXIST/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  describe('the swift shim', () => {
    it.each([
      [['build', '-c', 'release'], ['build', '--disable-sandbox', '-c', 'release']],
      [['test', '--filter', 'MyTests'], ['test', '--disable-sandbox', '--filter', 'MyTests']],
      [['run', 'tool', '--', 'a', 'b'], ['run', '--disable-sandbox', 'tool', '--', 'a', 'b']],
      // --disable-sandbox is an option of `swift package`, before its subcommand.
      [['package', 'resolve'], ['package', '--disable-sandbox', 'resolve']],
      [['package', 'plugin', '--allow-writing-to-package-directory', 'fmt'], ['package', '--disable-sandbox', 'plugin', '--allow-writing-to-package-directory', 'fmt']],
    ])('turns SwiftPM\'s own sandbox off for swift %j, right after the subcommand', (args, expected) => {
      const bin = writeJobBin(sandbox, { dockerCli, shims: true });
      expect(call(bin, 'swift', args)).toEqual({ status: 0, argv: ['swift', ...expected], stderr: '' });
    });

    it.each([
      [['build', '--disable-sandbox']],
      [['package', '--disable-sandbox', 'resolve']],
      [['--version']],
      [['repl']],
      [['sdk', 'list']],
      [['format', 'Sources']],
      [[]],
    ])('passes swift %j through as it is', (args) => {
      const bin = writeJobBin(sandbox, { dockerCli, shims: true });
      expect(call(bin, 'swift', args)).toEqual({ status: 0, argv: ['swift', ...args], stderr: '' });
    });

    it("adds its own when --disable-sandbox is only the program's argument, after --", () => {
      const bin = writeJobBin(sandbox, { dockerCli, shims: true });
      expect(call(bin, 'swift', ['run', 'tool', '--', '--disable-sandbox']).argv).toEqual(
        ['swift', 'run', '--disable-sandbox', 'tool', '--', '--disable-sandbox']
      );
    });

    it('keeps every argument whole, spaces, quotes and globs included', () => {
      const bin = writeJobBin(sandbox, { dockerCli, shims: true });
      const args = ['build', '-Xswiftc', '-DA B', "it's", '*', ''];
      expect(call(bin, 'swift', args).argv).toEqual(['swift', 'build', '--disable-sandbox', '-Xswiftc', '-DA B', "it's", '*', '']);
    });

    it('runs the next swift on PATH after its own directory, however often that is listed', () => {
      const bin = writeJobBin(sandbox, { dockerCli, shims: true });
      expect(call(bin, 'swift', ['build'], [bin, bin, '', '/nonexistent', stubs]).argv).toEqual(['swift', 'build', '--disable-sandbox']);
    });

    it('never takes itself for the next swift, however PATH spells its directory', () => {
      // Matched by its spelling alone, a trailing slash or a route through
      // .. had the shim find itself, and exec itself until the job timed out.
      const bin = writeJobBin(sandbox, { dockerCli, shims: true });
      const spellings = [`${bin}/`, `${bin}//`, path.join(bin, '..', 'bin') + '/.', `${path.dirname(bin)}/../localmost/bin`];
      expect(call(bin, 'swift', ['build'], [bin, ...spellings, stubs]).argv).toEqual(['swift', 'build', '--disable-sandbox']);
      const result = call(bin, 'swift', ['build'], [bin, ...spellings]);
      expect([result.status, result.stderr]).toEqual([127, expect.stringContaining('swift: command not found')]);
    });

    it('passes swift package --version through: package takes no --version after --disable-sandbox', () => {
      // `swift package --disable-sandbox --version` exits 64 with "Unknown
      // option '--version'", wherever --version is; build, test and run take it.
      const bin = writeJobBin(sandbox, { dockerCli, shims: true });
      for (const args of [['package', '--version'], ['package', '--package-path', '.', '--version']]) {
        expect(call(bin, 'swift', args)).toEqual({ status: 0, argv: ['swift', ...args], stderr: '' });
      }
      expect(call(bin, 'swift', ['package', 'resolve', '--', '--version']).argv).toEqual(
        ['swift', 'package', '--disable-sandbox', 'resolve', '--', '--version']
      );
    });

    it('fails as a missing command does when there is no other swift on PATH', () => {
      const bin = writeJobBin(sandbox, { dockerCli, shims: true });
      const result = call(bin, 'swift', ['build'], [bin, '/nonexistent']);
      expect(result.status).toBe(127);
      expect(result.stderr).toContain('swift: command not found');
    });
  });

  describe('the xcodebuild shim', () => {
    it("turns Xcode's package manifest sandbox off", () => {
      const bin = writeJobBin(sandbox, { dockerCli, shims: true });
      expect(call(bin, 'xcodebuild', ['-scheme', 'App', 'build']).argv).toEqual(
        ['xcodebuild', '-scheme', 'App', 'build', '-IDEPackageSupportDisableManifestSandbox=YES']
      );
    });

    it.each([
      [[]],
      [['-workspace', 'App.xcworkspace', '-scheme', 'App', '-destination', 'generic/platform=iOS']],
      [['test', '-project', 'App.xcodeproj']],
      [['archive', '-archivePath', 'build/App.xcarchive']],
      [['analyze']],
      [['build-for-testing']],
      [['test-without-building']],
      [['-resolvePackageDependencies']],
      [['-list']],
      [['-showBuildSettings', '-json']],
      [['-showdestinations']],
      [['-alltargets', 'clean']],
    ])('adds it to xcodebuild %j, which resolves packages', (args) => {
      const bin = writeJobBin(sandbox, { dockerCli, shims: true });
      expect(call(bin, 'xcodebuild', args).argv).toEqual(['xcodebuild', ...args, '-IDEPackageSupportDisableManifestSandbox=YES']);
    });

    it.each([
      // "error: invalid argument '-IDEPackageSupportDisableManifestSandbox=YES'", exit 70.
      [['-create-xcframework', '-framework', 'build/A.framework', '-output', 'build/A.xcframework']],
      [['-create-xcframework', '-library', 'test', '-output', 'build']],
      [['-version']],
      [['-showsdks', '-json']],
      [['-exportArchive', '-archivePath', 'App.xcarchive', '-exportPath', 'out', '-exportOptionsPlist', 'o.plist']],
      [['-checkFirstLaunchStatus']],
    ])('passes xcodebuild %j through as it is: it resolves no package', (args) => {
      const bin = writeJobBin(sandbox, { dockerCli, shims: true });
      expect(call(bin, 'xcodebuild', args)).toEqual({ status: 0, argv: ['xcodebuild', ...args], stderr: '' });
    });

    it('leaves the setting alone when the job gives it, either way', () => {
      const bin = writeJobBin(sandbox, { dockerCli, shims: true });
      for (const given of ['-IDEPackageSupportDisableManifestSandbox=NO', '-IDEPackageSupportDisableManifestSandbox=YES']) {
        expect(call(bin, 'xcodebuild', ['build', given]).argv).toEqual(['xcodebuild', 'build', given]);
      }
    });

    it('fails as a missing command does when there is no other xcodebuild on PATH', () => {
      const bin = writeJobBin(sandbox, { dockerCli, shims: true });
      expect(call(bin, 'xcodebuild', [], [bin]).status).toBe(127);
    });
  });
});
