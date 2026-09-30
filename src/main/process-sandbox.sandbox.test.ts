/**
 * Integration coverage for the runner profile's filesystem floor, signals and
 * loopback at the seatbelt layer.
 *
 * The unit tests assert which rules the runner profile contains. They cannot
 * show that seatbelt accepts them - a rule the engine rejects fails every
 * worker spawn - or that a process under them is kept out of the shared temp
 * directories, the user's toolchain trees, the app's own data, other
 * processes and loopback services it was not granted, whatever spelling a
 * future rule takes. So the same two modes as the docker isolation test:
 *
 *   constructed  On an unsandboxed machine, build the runner profile and
 *                apply it with sandbox-exec. Tests both directions: what the
 *                profile grants is writable, which is what makes each refusal
 *                mean anything.
 *
 *   ambient      Inside a localmost job, this process already runs under the
 *                runner's profile, and seatbelt refuses any nested profile
 *                that deviates from it, so assert what that profile does.
 *
 * Neither mode skips. macOS only, because seatbelt is.
 */

import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { execFileSync, spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import { app } from 'electron';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { generateSandboxProfile, RunnerProfileOptions } from './process-sandbox';

const isMacOS = process.platform === 'darwin';
const homeDir = os.homedir();

/** A name no other process is using, for a probe that must not collide. */
const probeName = () => `localmost-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

/** The per-user temp directory bare mktemp writes to, resolved as seatbelt sees it. */
const userTempDir = (): string =>
  fs.realpathSync(execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf-8' }).trim());

/** Run a shell command under the given profile file, or under the current one. */
const shell = (command: string, profilePath?: string, env: NodeJS.ProcessEnv = process.env) => {
  const argv = profilePath
    ? ['/usr/bin/sandbox-exec', ['-f', profilePath, '/bin/sh', '-c', command]] as const
    : ['/bin/sh', ['-c', command]] as const;
  const result = spawnSync(argv[0], [...argv[1]], { encoding: 'utf-8', timeout: 15000, env });
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr };
};

/** Whether `run` can write a new file at `target`; it is removed afterwards either way. */
const canCreate = (run: (command: string) => { ok: boolean }, target: string): boolean => {
  const existed = fs.existsSync(target);
  // touch, not a redirect: on a file that already exists, a write the sandbox
  // wrongly allowed changes only its time, never its contents.
  const ok = run(`/usr/bin/touch '${target}'`).ok;
  if (!existed && fs.existsSync(target)) fs.rmSync(target, { force: true });
  return ok;
};

/**
 * Whether `run` can create a directory under `parent`, creating `parent` too
 * if it does not exist. Either way the answer is the sandbox's: whether the
 * tree is there on this machine or not, a refused write is EPERM.
 */
const canCreateUnder = (run: (command: string) => { ok: boolean }, parent: string): boolean => {
  const parentExisted = fs.existsSync(parent);
  const target = path.join(parent, probeName());
  const ok = run(`/bin/mkdir -p '${target}'`).ok;
  fs.rmSync(parentExisted ? target : parent, { recursive: true, force: true });
  return ok;
};

/** Whether bare `mktemp` (or `mktemp -d`) works, and where its entry landed. */
const bareMktemp = (run: (command: string) => { ok: boolean; stdout: string }, flag: '' | '-d') => {
  const result = run(`/usr/bin/mktemp ${flag}`);
  if (result.stdout) fs.rmSync(result.stdout, { recursive: true, force: true });
  return { ok: result.ok, entry: result.stdout };
};

/**
 * Whether this process is outside any sandbox, so a profile can be constructed
 * and applied. Probed with `(allow default)`, the one profile seatbelt never
 * applies inside a sandbox - not with the runner profile, since a runner
 * profile the engine rejected would then pass for ambient mode instead of
 * failing the test that compiles it.
 */
const canConstruct = (): boolean => {
  if (!isMacOS) return false;
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], {
      timeout: 5000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
};

if (!isMacOS) {
  describe("the runner profile's filesystem floor through seatbelt", () => {
    it('has nothing to assert off macOS, where seatbelt does not exist', () => {
      expect(process.platform).not.toBe('darwin');
    });
  });
} else if (canConstruct()) {
  describe("the runner profile's filesystem floor through a constructed seatbelt profile", () => {
    // Resolved: os.tmpdir() is under /var, a symlink, and seatbelt matches
    // the canonical path. The instance directory stands in for the worker's
    // sandbox; the package cache sits beside it, outside it, as a target's
    // does.
    let base: string;
    let instanceDir: string;
    let packageCacheDir: string;
    let jobTmp: string;

    beforeAll(() => {
      base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-runner-')));
      instanceDir = path.join(base, 'instance');
      packageCacheDir = path.join(base, 'packages');
      jobTmp = path.join(instanceDir, '_temp');
      fs.mkdirSync(jobTmp, { recursive: true });
      fs.mkdirSync(packageCacheDir, { recursive: true });
    });

    afterAll(() => {
      fs.rmSync(base, { recursive: true, force: true });
    });

    // The job's TMPDIR, as the worker's is: inside its own sandbox.
    const jobEnv = () => ({ PATH: '/usr/bin:/bin', HOME: homeDir, TMPDIR: jobTmp });

    /** Write the runner profile built from `options`, and return its path. */
    const writeProfile = (options: Omit<RunnerProfileOptions, 'instanceDir'> = {}): string => {
      const profilePath = path.join(base, `${probeName()}.sb`);
      fs.writeFileSync(profilePath, generateSandboxProfile({ instanceDir, ...options }));
      return profilePath;
    };

    /** A runner for shell commands under the runner profile built from `options`. */
    const underProfile = (options: Omit<RunnerProfileOptions, 'instanceDir'> = {}) => {
      const profilePath = writeProfile(options);
      return (command: string) => shell(command, profilePath, jobEnv());
    };

    it('compiles, and writes the job its own sandbox', () => {
      const run = underProfile();
      expect(run('/usr/bin/true').ok).toBe(true);
      expect(canCreate(run, path.join(jobTmp, probeName()))).toBe(true);
    });

    it.each(['strict', 'moderate', 'permissive'] as const)('refuses writes to /private/tmp under %s', (level) => {
      const run = underProfile({ filesystemPolicy: { level, read: [], write: [] } });
      expect(canCreate(run, path.join('/private/tmp', probeName()))).toBe(false);
      expect(canCreate(run, path.join('/tmp', probeName()))).toBe(false);
    });

    it('lets bare mktemp and mktemp -d create their entries in the per-user temp', () => {
      const run = underProfile();
      const file = bareMktemp(run, '');
      const dir = bareMktemp(run, '-d');
      expect(file.ok).toBe(true);
      expect(dir.ok).toBe(true);
      expect(fs.realpathSync(path.dirname(file.entry))).toBe(userTempDir());
    });

    it('refuses the per-user temp itself, where the xcrun cache the user trusts lives', () => {
      const run = underProfile();
      expect(canCreate(run, path.join(userTempDir(), 'xcrun_db'))).toBe(false);
      expect(canCreate(run, path.join(userTempDir(), probeName()))).toBe(false);
    });

    it("writes its target's package cache under moderate, and none of the user's toolchain trees", () => {
      const run = underProfile({ filesystemPolicy: { level: 'moderate', read: [], write: [] }, packageCacheDir });
      expect(canCreateUnder(run, packageCacheDir)).toBe(true);
      for (const tree of ['.cargo', '.gradle', 'go', '.local']) {
        expect(canCreateUnder(run, path.join(homeDir, tree))).toBe(false);
      }
    });

    /**
     * The runner profile built from `options` with the app's directory at
     * `appDir`, which is read when the profile is built and only then.
     */
    const profileWithAppDir = (appDir: string, options: Omit<RunnerProfileOptions, 'instanceDir'>): string => {
      const previous = process.env.LOCALMOST_CONFIG_DIR;
      process.env.LOCALMOST_CONFIG_DIR = appDir;
      try {
        return generateSandboxProfile({ instanceDir, ...options });
      } finally {
        if (previous === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
        else process.env.LOCALMOST_CONFIG_DIR = previous;
      }
    };

    /** A runner for shell commands under the given profile text. */
    const underProfileText = (profile: string) => {
      const profilePath = path.join(base, `${probeName()}.sb`);
      fs.writeFileSync(profilePath, profile);
      return (command: string) => shell(command, profilePath, jobEnv());
    };

    /** An app directory with another worker's sandbox, the logs and the runner template in it. */
    const makeAppDir = (name: string): string => {
      const appDir = path.join(base, name);
      fs.mkdirSync(path.join(appDir, 'logs'), { recursive: true });
      fs.mkdirSync(path.join(appDir, 'runner', 'arc'), { recursive: true });
      fs.mkdirSync(path.join(appDir, 'runner', 'sandbox', '2'), { recursive: true });
      fs.writeFileSync(path.join(appDir, 'runner', 'sandbox', '2', 'token'), 'token');
      fs.writeFileSync(path.join(appDir, 'logs', 'app.log'), 'log');
      return appDir;
    };

    it("refuses writes to the app's own data directory, whatever the policy grants", () => {
      // Logs, job history and the runner template live beside the job's
      // sandbox; the directory is denied after every grant, a grant of the
      // whole of it included.
      const configDir = makeAppDir('config');
      const granted = path.join(base, 'granted');
      fs.mkdirSync(granted, { recursive: true });
      const run = underProfileText(profileWithAppDir(configDir, {
        filesystemPolicy: { level: 'strict', read: [], write: [configDir, granted] },
      }));
      expect(canCreate(run, path.join(granted, probeName()))).toBe(true);
      expect(canCreate(run, path.join(configDir, 'logs', probeName()))).toBe(false);
      expect(canCreate(run, path.join(configDir, 'job-history.json'))).toBe(false);
      expect(canCreate(run, path.join(configDir, 'runner', 'arc', probeName()))).toBe(false);
    });

    it("keeps a grant that contains the app's data directory, less the directory", () => {
      // A grant of the directory above the app's reaches everything else in
      // there as approved. The app's directory is denied after it, and the
      // job's own sandbox and its target's caches, inside that directory as a
      // worker's are, given back.
      const appDir = base;
      makeAppDir('.');
      const above = path.dirname(appDir);
      const run = underProfileText(profileWithAppDir(appDir, {
        filesystemPolicy: { level: 'moderate', read: [above], write: [above] },
        packageCacheDir,
      }));
      expect(canCreate(run, path.join(above, probeName()))).toBe(true);
      expect(canCreate(run, path.join(appDir, 'logs', probeName()))).toBe(false);
      expect(canCreate(run, path.join(appDir, 'job-history.json'))).toBe(false);
      expect(canCreate(run, path.join(appDir, 'runner', 'arc', probeName()))).toBe(false);
      expect(canCreate(run, path.join(appDir, 'runner', 'sandbox', '2', probeName()))).toBe(false);
      expect(run(`/bin/cat '${path.join(appDir, 'runner', 'sandbox', '2', 'token')}'`).ok).toBe(false);
      expect(run(`/bin/cat '${path.join(appDir, 'logs', 'app.log')}'`).ok).toBe(false);
      expect(canCreate(run, path.join(jobTmp, probeName()))).toBe(true);
      expect(canCreateUnder(run, packageCacheDir)).toBe(true);
    });

    it("refuses the app's data directory before the app has created it, by its real path", () => {
      // Configured through /var, a symlink, and not there yet: a job granted
      // the directory above it by its real path could otherwise make it, and
      // plant what the app would then trust.
      const parent = path.join(base, 'unborn');
      fs.mkdirSync(parent, { recursive: true });
      const spelled = path.join(parent, 'app').replace(/^\/private\//, '/');
      expect(spelled).not.toBe(path.join(parent, 'app'));
      const run = underProfileText(profileWithAppDir(spelled, {
        filesystemPolicy: { level: 'strict', read: [], write: [parent] },
      }));
      expect(canCreate(run, path.join(parent, probeName()))).toBe(true);
      expect(canCreateUnder(run, path.join(parent, 'app'))).toBe(false);
    });

    it("refuses the directories on the way to the app's data directory before they exist", () => {
      // A job granted the directory above could otherwise put a link where
      // the app will later create the rest of the way down, and have the
      // app's directory made wherever the link points.
      const parent = path.join(base, 'unborn-above');
      const elsewhere = path.join(base, 'unborn-elsewhere');
      fs.mkdirSync(parent, { recursive: true });
      fs.mkdirSync(elsewhere, { recursive: true });
      const middle = path.join(parent, 'middle');
      const run = underProfileText(profileWithAppDir(path.join(middle, 'app'), {
        filesystemPolicy: { level: 'strict', read: [], write: [parent, elsewhere] },
      }));
      expect(canCreate(run, path.join(parent, probeName()))).toBe(true);
      const linked = run(`/bin/ln -s '${elsewhere}' '${middle}'`);
      const made = run(`/bin/mkdir '${middle}'`);
      fs.rmSync(middle, { recursive: true, force: true });
      expect(linked.ok).toBe(false);
      expect(made.ok).toBe(false);
    });

    it("refuses reads of the app's data directory granted in another case", () => {
      // seatbelt matches paths case-insensitively on the default APFS volume,
      // so a grant spelled in capitals reaches what the lower-case one would:
      // other workers' sandboxes and the logs.
      const appDir = makeAppDir('cased');
      const run = underProfileText(profileWithAppDir(appDir, {
        filesystemPolicy: { level: 'strict', read: [appDir.toUpperCase()], write: [] },
      }));
      const own = path.join(jobTmp, probeName());
      fs.writeFileSync(own, 'own');
      expect(run(`/bin/cat '${own}'`).ok).toBe(true);
      expect(run(`/bin/cat '${path.join(appDir, 'runner', 'sandbox', '2', 'token')}'`).ok).toBe(false);
      expect(run(`/bin/cat '${path.join(appDir, 'logs', 'app.log')}'`).ok).toBe(false);
    });

    it("refuses reads of the app's data directory granted by its real path", () => {
      // os.tmpdir() is under /var, a symlink to /private/var. seatbelt matches
      // the real path, so a grant of /private/var/... reaches an app directory
      // configured as /var/...
      const appDir = makeAppDir('linked');
      const spelled = appDir.replace(/^\/private\//, '/');
      expect(spelled).not.toBe(appDir);
      const run = underProfileText(profileWithAppDir(spelled, {
        filesystemPolicy: { level: 'strict', read: [appDir], write: [] },
      }));
      expect(run(`/bin/cat '${path.join(appDir, 'runner', 'sandbox', '2', 'token')}'`).ok).toBe(false);
      expect(run(`/bin/cat '${path.join(appDir, 'logs', 'app.log')}'`).ok).toBe(false);
    });

    describe('under a policy that grants the whole home directory', () => {
      // The app's directories where a user's machine has them: ~/.localmost
      // and Electron's under ~/Library/Application Support, both inside what
      // a grant of ~ covers. Stood in for by a directory of this test's own in
      // the real home directory, so the grant reaches them as it would the
      // real ones.
      let home: string;
      let appDir: string;
      let userData: string;
      let instance: string;
      let ownCache: string;
      let otherCache: string;
      let sibling: string;

      beforeAll(() => {
        home = fs.realpathSync(fs.mkdtempSync(path.join(homeDir, 'localmost-probe-')));
        appDir = path.join(home, '.localmost');
        userData = path.join(home, 'Library', 'Application Support', 'localmost');
        instance = path.join(appDir, 'runner', 'sandbox', '1');
        sibling = path.join(appDir, 'runner', 'sandbox', '2');
        ownCache = path.join(appDir, 'runner', 'caches', 'aaaa1111', 'tool-cache');
        otherCache = path.join(appDir, 'runner', 'caches', 'bbbb2222', 'tool-cache');
        for (const dir of [path.join(instance, '_temp'), sibling, ownCache, otherCache, userData,
          path.join(appDir, 'logs'), path.join(appDir, 'runner', 'arc'), path.join(home, 'project')]) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const files: Record<string, string> = {
          [path.join(instance, 'own')]: 'own',
          [path.join(ownCache, 'node')]: 'node',
          [path.join(otherCache, 'node')]: 'node',
          [path.join(sibling, 'token')]: 'token',
          [path.join(appDir, 'logs', 'app.log')]: 'log',
          [path.join(appDir, 'runner', 'broker-sessions.json.tmp')]: '{}',
          [path.join(userData, 'Cookies')]: 'cookies',
          [path.join(home, 'project', 'README')]: 'readme',
        };
        for (const [file, content] of Object.entries(files)) fs.writeFileSync(file, content);
      });

      afterAll(() => {
        fs.rmSync(home, { recursive: true, force: true });
      });

      /** A runner for shell commands in the job at `instance`, under read and write grants of ~. */
      const underHomeGrant = () => {
        const previousConfig = process.env.LOCALMOST_CONFIG_DIR;
        const getPath = jest.mocked(app.getPath);
        const previousUserData = app.getPath('userData');
        process.env.LOCALMOST_CONFIG_DIR = appDir;
        getPath.mockReturnValue(userData);
        let profile: string;
        try {
          profile = generateSandboxProfile({
            instanceDir: instance,
            toolCacheDir: ownCache,
            filesystemPolicy: { level: 'strict', read: ['~'], write: ['~'] },
          });
        } finally {
          if (previousConfig === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
          else process.env.LOCALMOST_CONFIG_DIR = previousConfig;
          getPath.mockReturnValue(previousUserData);
        }
        const profilePath = path.join(base, `${probeName()}.sb`);
        fs.writeFileSync(profilePath, profile);
        const env = { PATH: '/usr/bin:/bin', HOME: homeDir, TMPDIR: path.join(instance, '_temp') };
        const run = (command: string) => shell(command, profilePath, env);
        // The grant is in force, so each refusal below is the deny's doing
        // and not the grant's absence.
        expect(canCreate(run, path.join(home, 'project', probeName()))).toBe(true);
        return run;
      };
      const cat = (run: (command: string) => { ok: boolean }, file: string) => run(`/bin/cat '${file}'`).ok;

      it('reads and writes the rest of the home directory, as granted', () => {
        const run = underHomeGrant();
        expect(canCreateUnder(run, path.join(home, 'elsewhere'))).toBe(true);
        expect(cat(run, path.join(home, 'project', 'README'))).toBe(true);
        // And Electron's neighbours: a grant of ~/Library is no less a grant.
        expect(canCreateUnder(run, path.join(home, 'Library', 'Application Support', 'another-app'))).toBe(true);
      });

      it("reads and writes its own sandbox and its target's cache in the app's directory", () => {
        const run = underHomeGrant();
        expect(canCreate(run, path.join(instance, '_temp', probeName()))).toBe(true);
        expect(cat(run, path.join(instance, 'own'))).toBe(true);
        expect(canCreate(run, path.join(ownCache, probeName()))).toBe(true);
        expect(cat(run, path.join(ownCache, 'node'))).toBe(true);
      });

      it("neither reads nor writes anything else in the app's directories", () => {
        const run = underHomeGrant();
        for (const dir of [appDir, path.join(appDir, 'logs'), path.join(appDir, 'runner', 'arc'), sibling, otherCache, userData]) {
          expect(canCreate(run, path.join(dir, probeName()))).toBe(false);
        }
        expect(canCreate(run, path.join(appDir, 'job-history.json'))).toBe(false);
        for (const file of [
          path.join(appDir, 'logs', 'app.log'),
          path.join(otherCache, 'node'),
          // Refused here by the deny of the app's directories as much as by
          // name; the unit test that evaluates the named deny on its own is
          // what shows the name covers it.
          path.join(appDir, 'runner', 'broker-sessions.json.tmp'),
          path.join(userData, 'Cookies'),
        ]) {
          expect(cat(run, file)).toBe(false);
        }
      });

      it("cannot move the app's directories out from under the deny by renaming a directory above them", () => {
        // Renamed, the directory would sit outside the path the deny names,
        // readable and writable under ~ until moved back. Each rename is
        // undone from outside the sandbox should the sandbox let it through.
        const run = underHomeGrant();
        const cookies = path.join(userData, 'Cookies');
        for (const above of [path.dirname(userData), path.join(home, 'Library'), home]) {
          const moved = `${above}-moved`;
          const result = run(`/bin/mv '${above}' '${moved}' && /bin/cat '${path.join(moved, path.relative(above, cookies))}'`);
          if (fs.existsSync(moved)) fs.renameSync(moved, above);
          expect(result.stdout).not.toContain('cookies');
          expect(result.ok).toBe(false);
          expect(result.stderr).toContain('Operation not permitted');
        }
        expect(fs.readFileSync(cookies, 'utf-8')).toBe('cookies');
      });

      it("cannot read another worker's sandbox", () => {
        const run = underHomeGrant();
        expect(cat(run, path.join(sibling, 'token'))).toBe(false);
        expect(run(`/bin/ls '${sibling}'`).ok).toBe(false);
      });
    });

    it('refuses what a policy denies, read and write, inside what it grants', () => {
      const out = path.join(base, 'out');
      const secret = path.join(out, 'secret');
      fs.mkdirSync(secret, { recursive: true });
      fs.writeFileSync(path.join(out, 'visible'), 'visible');
      fs.writeFileSync(path.join(secret, 'key'), 'key');
      const run = underProfile({ filesystemPolicy: { level: 'strict', read: [out], write: [out], deny: [secret] } });
      expect(canCreate(run, path.join(out, probeName()))).toBe(true);
      expect(run(`/bin/cat '${path.join(out, 'visible')}'`).ok).toBe(true);
      expect(canCreate(run, path.join(secret, probeName()))).toBe(false);
      expect(run(`/bin/cat '${path.join(secret, 'key')}'`).ok).toBe(false);
    });

    it('refuses a file a glob deny matches', () => {
      const out = path.join(base, 'globbed');
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'x.pem'), 'key');
      fs.writeFileSync(path.join(out, 'x.txt'), 'visible');
      const run = underProfile({ filesystemPolicy: { level: 'strict', read: [out], write: [out], deny: [`${out}/*.pem`] } });
      expect(run(`/bin/cat '${path.join(out, 'x.txt')}'`).ok).toBe(true);
      expect(canCreate(run, path.join(out, probeName()))).toBe(true);
      expect(run(`/bin/cat '${path.join(out, 'x.pem')}'`).ok).toBe(false);
      expect(canCreate(run, path.join(out, `${probeName()}.pem`))).toBe(false);
    });

    it('cannot move what a policy denies out from under the deny by renaming a directory above it', () => {
      // The deny matches paths, so renamed, the secret would sit under a name
      // the write grant covers and the deny does not. Each rename is undone
      // from outside the sandbox should the sandbox let it through.
      const out = path.join(base, 'renamed');
      for (const dir of [path.join(out, 'a', 'secret'), path.join(out, 'g')]) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(out, 'a', 'secret', 'key'), 'key');
      fs.writeFileSync(path.join(out, 'g', 'x.pem'), 'key');
      const run = underProfile({
        filesystemPolicy: {
          level: 'strict', read: [out], write: [out], deny: [path.join(out, 'a', 'secret'), `${out}/g/*.pem`],
        },
      });
      for (const [above, file] of [['a', path.join('secret', 'key')], ['g', 'x.pem']]) {
        const from = path.join(out, above);
        const moved = `${from}-moved`;
        const result = run(`/bin/mv '${from}' '${moved}' && /bin/cat '${path.join(moved, file)}'`);
        if (fs.existsSync(moved)) fs.renameSync(moved, from);
        expect(result.stdout).not.toContain('key');
        expect(result.ok).toBe(false);
      }
      const whole = run(`/bin/mv '${out}' '${out}-moved' && /bin/cat '${out}-moved/a/secret/key'`);
      if (fs.existsSync(`${out}-moved`)) fs.renameSync(`${out}-moved`, out);
      expect(whole.ok).toBe(false);
      // What the grant gives stays given: a new file beside the secret.
      expect(canCreate(run, path.join(out, 'a', probeName()))).toBe(true);
      expect(canCreate(run, path.join(out, 'g', probeName()))).toBe(true);
    });

    it('refuses what a policy denies by a spelling that runs through a symlink', () => {
      // /tmp is a symlink to /private/tmp, and a link of the user's is one
      // too; seatbelt matches where they lead.
      const real = fs.realpathSync(fs.mkdtempSync('/tmp/localmost-deny-'));
      const viaTmp = real.replace(/^\/private/, '');
      const link = path.join(base, probeName());
      try {
        for (const dir of ['a', 'b']) {
          fs.mkdirSync(path.join(real, dir));
          fs.writeFileSync(path.join(real, dir, 'key'), 'key');
        }
        fs.writeFileSync(path.join(real, 'visible'), 'visible');
        fs.writeFileSync(path.join(real, 'x.pem'), 'key');
        fs.symlinkSync(real, link);
        const run = underProfile({
          filesystemPolicy: {
            level: 'strict', read: [real], write: [real], deny: [path.join(viaTmp, 'a'), path.join(link, 'b'), `${viaTmp}/*.pem`],
          },
        });
        expect(viaTmp).toMatch(/^\/tmp\//);
        expect(run(`/bin/cat '${path.join(real, 'visible')}'`).ok).toBe(true);
        // A glob through the link too: the directory before its * is resolved.
        expect(run(`/bin/cat '${path.join(real, 'x.pem')}'`).ok).toBe(false);
        expect(run(`/bin/cat '${path.join(real, 'a', 'key')}'`).ok).toBe(false);
        expect(canCreate(run, path.join(real, 'a', probeName()))).toBe(false);
        expect(run(`/bin/cat '${path.join(real, 'b', 'key')}'`).ok).toBe(false);
        expect(run(`/bin/cat '${path.join(link, 'b', 'key')}'`).ok).toBe(false);
      } finally {
        fs.rmSync(link, { force: true });
        fs.rmSync(real, { recursive: true, force: true });
      }
    });

    it('builds and applies a deny beneath what it cannot look up: an unsearchable directory, a symlink loop', () => {
      // The job cannot pass through either, so the deny holds as written;
      // stopping every spawn for the repository over it helped no one.
      const out = path.join(base, 'unresolvable');
      fs.mkdirSync(path.join(out, 'locked', 'inner'), { recursive: true });
      fs.writeFileSync(path.join(out, 'visible'), 'visible');
      fs.symlinkSync('loop', path.join(out, 'loop'));
      fs.chmodSync(path.join(out, 'locked'), 0o000);
      try {
        const run = underProfile({
          filesystemPolicy: {
            level: 'strict', read: [out], write: [out], deny: [path.join(out, 'locked', 'inner', 'secret'), path.join(out, 'loop', 'secret')],
          },
        });
        expect(run(`/bin/cat '${path.join(out, 'visible')}'`).ok).toBe(true);
        expect(canCreate(run, path.join(out, probeName()))).toBe(true);
      } finally {
        fs.chmodSync(path.join(out, 'locked'), 0o755);
        fs.rmSync(out, { recursive: true, force: true });
      }
    });

    it('lets a job signal its own children, and no process outside its sandbox', () => {
      const outside = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
      try {
        const run = underProfile();
        expect(run(`/bin/kill -0 ${outside.pid}`).ok).toBe(false);
        expect(run('/bin/sleep 60 & C=$!; /bin/kill -0 $C && /bin/kill -TERM $C').ok).toBe(true);
      } finally {
        outside.kill('SIGKILL');
      }
    });

    it('signals the members of its process group that share its sandbox, and no others', async () => {
      // An unsandboxed shell leads a fresh process group - never this test's
      // own - and starts one process outside the sandbox and then the job in
      // the same group. The job signals the whole group: its own child gets
      // it; the shell and the outside process must not.
      const profilePath = writeProfile();
      const job = '/bin/sleep 60 & C=$!; trap "" TERM; kill -TERM 0; wait $C; echo child=$?';
      const script = [
        '/bin/sleep 60 & OUTSIDE=$!',
        `/usr/bin/sandbox-exec -f '${profilePath}' /bin/sh -c '${job}'`,
        '/bin/kill -0 $OUTSIDE && echo outside=alive',
        '/bin/kill -KILL $OUTSIDE',
      ].join('\n');
      const shellProcess = spawn('/bin/sh', ['-c', script], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: jobEnv(),
      });
      let stdout = '';
      shellProcess.stdout.setEncoding('utf-8').on('data', (chunk: string) => { stdout += chunk; });
      const timer = setTimeout(() => shellProcess.kill('SIGKILL'), 15000);
      await new Promise((resolve) => shellProcess.on('close', resolve));
      clearTimeout(timer);
      expect(stdout).toContain('child=143');
      expect(stdout).toContain('outside=alive');
    });

    describe('loopback', () => {
      // Listeners outside the sandbox: one stands in for the worker's proxy,
      // the others for services on this machine. A connect under seatbelt is
      // refused before it leaves the process, and one it allows completes
      // against the listen backlog while this process waits.
      let proxy: net.Server;
      let broker: net.Server;
      let service: net.Server;
      let other: net.Server;
      const portOf = (server: net.Server) => (server.address() as net.AddressInfo).port;
      const listen = () =>
        new Promise<net.Server>((resolve, reject) => {
          const server = net.createServer((socket) => socket.destroy());
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => resolve(server));
        });
      const reaches = (run: (command: string) => { ok: boolean }, server: net.Server) =>
        run(`/usr/bin/nc -z -G 2 127.0.0.1 ${portOf(server)}`).ok;

      beforeAll(async () => {
        proxy = await listen();
        broker = await listen();
        service = await listen();
        other = await listen();
      });

      afterAll(async () => {
        await Promise.all([proxy, broker, service, other].map((server) => new Promise((resolve) => server.close(resolve))));
      });

      it('reaches its own proxy and the broker, and nothing else on loopback by default', () => {
        // The runner dials the broker directly - its HTTP client sends a
        // loopback destination around the proxy - so a profile that closed
        // the broker's port left every worker unable to open its session.
        const run = underProfile({ proxyPort: portOf(proxy), brokerPort: portOf(broker) });
        expect(reaches(run, proxy)).toBe(true);
        expect(reaches(run, broker)).toBe(true);
        expect(reaches(run, service)).toBe(false);
      });

      it('reaches a service whose port the policy declares, and not one whose port it does not', () => {
        const run = underProfile({
          proxyPort: portOf(proxy),
          filesystemPolicy: { level: 'strict', read: [], write: [], loopback: [portOf(service)] },
        });
        expect(reaches(run, proxy)).toBe(true);
        expect(reaches(run, service)).toBe(true);
        expect(reaches(run, other)).toBe(false);
      });

      it('reaches every loopback port only when the policy declares all of loopback', () => {
        const declared = underProfile({
          proxyPort: portOf(proxy),
          filesystemPolicy: { level: 'strict', read: [], write: [], loopback: true },
        });
        expect(reaches(declared, service)).toBe(true);
        expect(reaches(declared, other)).toBe(true);
        const undeclared = underProfile({ proxyPort: portOf(proxy) });
        expect(reaches(undeclared, service)).toBe(false);
        expect(reaches(undeclared, other)).toBe(false);
      });

      it('reaches nothing on loopback when it was given no proxy port', () => {
        const run = underProfile();
        expect(reaches(run, proxy)).toBe(false);
        expect(reaches(run, service)).toBe(false);
      });
    });
  });
} else {
  describe("the runner profile's filesystem floor through the ambient seatbelt profile", () => {
    // Already inside a localmost job: the runner applied this repository's
    // approved policy to this very process, and TMPDIR is the job's own.
    const run = (command: string) => shell(command);

    it("writes the job's own temp, so the refusals below are specific", () => {
      expect(canCreate(run, path.join(os.tmpdir(), probeName()))).toBe(true);
    });

    it('refuses writes to /private/tmp', () => {
      expect(canCreate(run, path.join('/private/tmp', probeName()))).toBe(false);
      expect(canCreate(run, path.join('/tmp', probeName()))).toBe(false);
    });

    it('lets bare mktemp and mktemp -d create their entries in the per-user temp', () => {
      expect(bareMktemp(run, '').ok).toBe(true);
      expect(bareMktemp(run, '-d').ok).toBe(true);
    });

    it('refuses the per-user temp itself, where the xcrun cache the user trusts lives', () => {
      expect(canCreate(run, path.join(userTempDir(), 'xcrun_db'))).toBe(false);
      expect(canCreate(run, path.join(userTempDir(), probeName()))).toBe(false);
    });

    it("writes where its package managers are pointed, and none of the user's toolchain trees", () => {
      // Under strict none are pointed anywhere; under moderate and permissive
      // each is the job's own or its target's package cache.
      for (const name of ['CARGO_HOME', 'GRADLE_USER_HOME', 'GOPATH']) {
        const dir = process.env[name];
        if (dir !== undefined) expect(canCreateUnder(run, dir)).toBe(true);
      }
      for (const tree of ['.cargo', '.gradle', 'go', '.local']) {
        expect(canCreateUnder(run, path.join(homeDir, tree))).toBe(false);
      }
    });

    it("refuses writes to the app's own data directory", () => {
      // Found from where the job runs, <app dir>/runner/sandbox/<n>/_temp, so
      // the directory is certainly there and a refusal is the sandbox's EPERM,
      // not a missing parent's ENOENT.
      const sandboxDir = path.dirname(fs.realpathSync(os.tmpdir()));
      expect(path.basename(path.dirname(sandboxDir))).toBe('sandbox');
      expect(path.basename(path.dirname(path.dirname(sandboxDir)))).toBe('runner');
      const appDir = path.dirname(path.dirname(path.dirname(sandboxDir)));
      const target = path.join(appDir, probeName());
      const result = run(`/usr/bin/touch '${target}'`);
      fs.rmSync(target, { force: true });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('Operation not permitted');
    });

    it("refuses reads in the app's own data directory outside the job's own sandbox", () => {
      // The runner template every worker is copied from, which is certainly
      // there while a job runs; listing it is a read of the directory itself.
      const sandboxDir = path.dirname(fs.realpathSync(os.tmpdir()));
      const runnerDir = path.dirname(path.dirname(sandboxDir));
      expect(path.basename(runnerDir)).toBe('runner');
      expect(fs.existsSync(path.join(runnerDir, 'arc'))).toBe(true);
      const result = run(`/bin/ls '${path.join(runnerDir, 'arc')}'`);
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('Operation not permitted');
    });

    it('signals its own children', () => {
      expect(run('/bin/sleep 60 & C=$!; /bin/kill -0 $C && /bin/kill -TERM $C').ok).toBe(true);
    });

    it('reaches a listener it starts on loopback, which this repository declares', async () => {
      // This repository's policy declares all of loopback: its test suites
      // bind ephemeral 127.0.0.1 ports and talk to themselves.
      const server = net.createServer((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const { port } = server.address() as net.AddressInfo;
        expect(run(`/usr/bin/nc -z -G 2 127.0.0.1 ${port}`).ok).toBe(true);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
}
