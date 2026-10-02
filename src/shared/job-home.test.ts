import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createMissingGrantedDirs,
  gitSshCommand,
  homeRelativeGrants,
  JOB_GIT_CONFIG,
  linkHomeGrants,
  prepareJobHome,
} from './job-home';

describe("a job's own home", () => {
  let root: string;
  let realHome: string;
  let jobHome: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-job-home-')));
    realHome = path.join(root, 'Users', 'someone');
    jobHome = path.join(root, 'sandbox', 'home');
    fs.mkdirSync(realHome, { recursive: true });
    fs.mkdirSync(jobHome, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const plant = (rel: string, content = 'x') => {
    const file = path.join(realHome, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  describe('homeRelativeGrants', () => {
    it('names a grant under the home by its path relative to it, ~ or absolute', () => {
      expect(homeRelativeGrants('~/.npm', realHome)).toEqual(['.npm']);
      expect(homeRelativeGrants(path.join(realHome, 'Library', 'Caches'), realHome)).toEqual(['Library/Caches']);
      expect(homeRelativeGrants('~/.cache/**', realHome)).toEqual(['.cache']);
    });

    it('names nothing for the home itself, a path outside it, a relative path or a traversal', () => {
      for (const grant of ['~', realHome, '/opt/homebrew', './build', '~/../other', path.join(root, 'Users', 'someone-else')]) {
        expect([grant, homeRelativeGrants(grant, realHome)]).toEqual([grant, []]);
      }
    });

    it('matches a * within one name against what is there now', () => {
      plant('Library/Caches/org.swift.swiftpm/a');
      plant('Library/Caches/org.swift.foo/a');
      plant('Library/Caches/com.other/a');
      plant('Library/Caches/org.swift/nested/x');
      expect(homeRelativeGrants('~/Library/Caches/org.swift.*', realHome).sort()).toEqual([
        'Library/Caches/org.swift.foo',
        'Library/Caches/org.swift.swiftpm',
      ]);
      expect(homeRelativeGrants('~/nothing-*/x', realHome)).toEqual([]);
    });
  });

  describe('linkHomeGrants', () => {
    it("links each grant into the job's home at the same path, to the real path", () => {
      plant('.npm/_cacache/index');
      plant('Library/Caches/pip/x');

      const linked = linkHomeGrants(jobHome, ['~/.npm', path.join(realHome, 'Library', 'Caches', 'pip'), '/opt/homebrew'], { realHome });

      expect(linked.sort()).toEqual(['.npm', 'Library/Caches/pip']);
      expect(fs.readlinkSync(path.join(jobHome, '.npm'))).toBe(path.join(realHome, '.npm'));
      expect(fs.readFileSync(path.join(jobHome, '.npm', '_cacache', 'index'), 'utf-8')).toBe('x');
      // The directories on the way are the job's own, not links.
      for (const dir of ['Library', 'Library/Caches']) {
        const stat = fs.lstatSync(path.join(jobHome, dir));
        expect([dir, stat.isDirectory(), stat.isSymbolicLink()]).toEqual([dir, true, false]);
      }
      expect(fs.lstatSync(path.join(jobHome, 'Library', 'Caches', 'pip')).isSymbolicLink()).toBe(true);
      // Nothing of the real home's is made or changed.
      expect(fs.readdirSync(realHome).sort()).toEqual(['.npm', 'Library']);
    });

    it('links a grant that does not exist yet too, so a tool creating it lands in the real path', () => {
      linkHomeGrants(jobHome, ['~/.gradle'], { realHome });
      expect(fs.readlinkSync(path.join(jobHome, '.gradle'))).toBe(path.join(realHome, '.gradle'));
    });

    it('gives a grant and one beneath it a single link, whichever is listed first', () => {
      plant('.cache/pip/x');
      plant('.cache/uv/y');

      const linked = linkHomeGrants(jobHome, ['~/.cache/pip', '~/.cache'], { realHome });

      expect(linked).toEqual(['.cache']);
      expect(fs.readFileSync(path.join(jobHome, '.cache', 'uv', 'y'), 'utf-8')).toBe('x');
    });

    it('never follows or replaces what is already there', () => {
      const elsewhere = path.join(root, 'elsewhere');
      fs.mkdirSync(elsewhere);
      fs.symlinkSync(elsewhere, path.join(jobHome, 'Library'));
      fs.writeFileSync(path.join(jobHome, '.npm'), 'mine');

      const linked = linkHomeGrants(jobHome, ['~/Library/Caches/pip', '~/.npm'], { realHome });

      expect(linked).toEqual([]);
      expect(fs.readdirSync(elsewhere)).toEqual([]);
      expect(fs.readFileSync(path.join(jobHome, '.npm'), 'utf-8')).toBe('mine');
    });
  });

  describe('createMissingGrantedDirs', () => {
    it('creates a missing granted directory one level at a time, empty, 0755', () => {
      const created = createMissingGrantedDirs(['~/.gradle/caches', '~/.npm'], { realHome });

      expect(created).toEqual([path.join(realHome, '.gradle'), path.join(realHome, '.gradle', 'caches'), path.join(realHome, '.npm')]);
      for (const dir of created) {
        const stat = fs.lstatSync(dir);
        expect(stat.isDirectory()).toBe(true);
        expect(stat.mode & 0o022).toBe(0);
        expect(fs.readdirSync(dir).filter((name) => !created.includes(path.join(dir, name)))).toEqual([]);
      }
    });

    it('leaves an existing directory as it is', () => {
      plant('.npm/keep');
      expect(createMissingGrantedDirs(['~/.npm'], { realHome })).toEqual([]);
      expect(fs.readdirSync(path.join(realHome, '.npm'))).toEqual(['keep']);
    });

    it('never creates through a link, nor over a file', () => {
      const elsewhere = path.join(root, 'elsewhere');
      fs.mkdirSync(elsewhere);
      fs.symlinkSync(elsewhere, path.join(realHome, '.cache'));
      plant('.m2', 'a file');
      const logged: string[] = [];

      const created = createMissingGrantedDirs(['~/.cache/pip', '~/.m2/repository'], { realHome, log: (_l, m) => logged.push(m) });

      expect(created).toEqual([]);
      expect(fs.readdirSync(elsewhere)).toEqual([]);
      expect(logged).toHaveLength(2);
    });

    it("creates nothing in or above the app's own directories", () => {
      // A policy can name a path there, which the job is denied anyway; a
      // directory made at a name the app uses - config.yaml - would break it.
      const appDir = path.join(realHome, '.localmost');
      fs.mkdirSync(appDir);
      expect(createMissingGrantedDirs(['~/.localmost/config.yaml', '~/.localmost/runner/x'], { realHome, excludeRoots: [appDir] })).toEqual([]);
      expect(fs.readdirSync(appDir)).toEqual([]);
      expect(createMissingGrantedDirs(['~/.npm'], { realHome, excludeRoots: [appDir] })).toEqual([path.join(realHome, '.npm')]);
    });

    it('creates nothing outside the home, for the home itself, or for a grant with * in it', () => {
      const outside = path.join(root, 'outside', 'dir');
      expect(createMissingGrantedDirs([outside, '~', '~/.cache/pip*', './build'], { realHome })).toEqual([]);
      expect(fs.existsSync(path.join(root, 'outside'))).toBe(false);
      expect(fs.readdirSync(realHome)).toEqual([]);
    });
  });

  describe('prepareJobHome', () => {
    it('writes the hermetic git config and an empty ssh config, and links the grants', () => {
      plant('.npm/x');

      const prepared = prepareJobHome(jobHome, { grants: ['~/.npm'], realHome });

      expect(prepared.gitConfig).toBe(path.join(jobHome, '.gitconfig'));
      expect(fs.readFileSync(prepared.gitConfig, 'utf-8')).toBe(JOB_GIT_CONFIG);
      expect(JOB_GIT_CONFIG).toContain('proxyAuthMethod = basic');
      expect(fs.statSync(path.join(jobHome, '.ssh')).mode & 0o777).toBe(0o700);
      expect(fs.readFileSync(path.join(jobHome, '.ssh', 'config'), 'utf-8')).toBe('');
      expect(prepared.linked).toEqual(['.npm']);
    });

    it("keeps the user's own dotfiles out of the job's home", () => {
      // A regular ~/.gitconfig broke actions/checkout, which copies
      // $HOME/.gitconfig, at every level; ~/.yarnrc.yml broke every Yarn 2+
      // command. Both are denied by the floor, and neither is in the job's
      // home to be found.
      plant('.gitconfig', '[credential]\n\thelper = osxkeychain\n');
      plant('.yarnrc.yml', 'npmAuthToken: secret\n');

      prepareJobHome(jobHome, { grants: [], realHome });

      expect(fs.readFileSync(path.join(jobHome, '.gitconfig'), 'utf-8')).toBe(JOB_GIT_CONFIG);
      expect(fs.existsSync(path.join(jobHome, '.yarnrc.yml'))).toBe(false);
    });

    it('never writes through a name already taken', () => {
      const victim = path.join(root, 'victim');
      fs.writeFileSync(victim, 'kept');
      fs.symlinkSync(victim, path.join(jobHome, '.gitconfig'));

      expect(() => prepareJobHome(jobHome, { grants: [], realHome })).toThrow(/EEXIST/);
      expect(fs.readFileSync(victim, 'utf-8')).toBe('kept');
    });
  });

  it("points ssh at the job's home, quoted for the shell git runs it through", () => {
    expect(gitSshCommand('/x/sandbox/home')).toBe(
      "ssh -F '/x/sandbox/home/.ssh/config' -o UserKnownHostsFile='/x/sandbox/home/.ssh/known_hosts'"
    );
    expect(gitSshCommand("/Users/o'brien/h")).toContain("-F '/Users/o'\\''brien/h/.ssh/config'");
  });
});
