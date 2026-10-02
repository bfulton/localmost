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

    it('names nothing for a path outside the home, a relative path or a traversal', () => {
      for (const grant of ['/opt/homebrew', './build', '~/../other', path.join(root, 'Users', 'someone-else')]) {
        expect([grant, homeRelativeGrants(grant, realHome)]).toEqual([grant, []]);
      }
    });

    it('names each entry of the home for a grant of the home itself, which cannot be linked into itself', () => {
      plant('.npm/x');
      plant('.rustup/y');
      for (const grant of ['~', '~/', '~/**', realHome]) {
        expect([grant, homeRelativeGrants(grant, realHome).sort()]).toEqual([grant, ['.npm', '.rustup']]);
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

    it("leaves the name free in the job's home for a grant that is not there", () => {
      // A dangling link there made a tool's own mkdir of it fail with EEXIST:
      // rustup-init's ~/.rustup, setup-dotnet's ~/.dotnet on a Mac without them.
      const logged: string[] = [];
      expect(linkHomeGrants(jobHome, ['~/.rustup', '~/.dotnet/tools'], { realHome, log: (_l, m) => logged.push(m) })).toEqual([]);
      expect(fs.readdirSync(jobHome)).toEqual([]);
      expect(logged).toEqual([
        "Not linking ~/.rustup into the job's home: nothing is there",
        "Not linking ~/.dotnet/tools into the job's home: nothing is there",
      ]);
    });

    it('links no credential the job is denied whatever it is granted, in any capitalization', () => {
      // Linked, each was found through HOME and failed with EPERM, as the
      // real path did: Yarn on a granted ~/.yarnrc.yml, ssh on a granted
      // known_hosts where GIT_SSH_COMMAND points it.
      plant('.yarnrc.yml', 'npmAuthToken: secret\n');
      plant('.ssh/known_hosts');
      plant('.aws/credentials');
      const logged: string[] = [];

      const linked = linkHomeGrants(jobHome, ['~/.yarnrc.yml', '~/.ssh/known_hosts', '~/.AWS', '~/.Yarnrc.yml'], {
        realHome,
        log: (_l, m) => logged.push(m),
      });

      expect(linked).toEqual([]);
      expect(fs.readdirSync(jobHome)).toEqual([]);
      expect(logged).toContain("Not linking ~/.yarnrc.yml into the job's home: the job is denied it whatever it is granted");
    });

    it('gives a granted directory holding a denied credential as a directory of links to all else in it', () => {
      // Linked whole, ~/.cache led huggingface_hub to the floor-denied token,
      // and ~/.gradle the Gradle wrapper to gradle.properties: each died on
      // EPERM, under the grant that was meant to help (L4, L5).
      plant('.cache/huggingface/token', 'hf_secret');
      plant('.cache/huggingface/stored_tokens', 'hf_secret');
      plant('.cache/huggingface/hub/model/config.json', '{}');
      plant('.cache/pip/x');
      plant('.gradle/gradle.properties', 'password=secret');
      plant('.gradle/caches/y');

      const linked = linkHomeGrants(jobHome, ['~/.cache', '~/.gradle'], { realHome });

      expect(linked.sort()).toEqual(['.cache/huggingface/hub', '.cache/pip', '.gradle/caches']);
      for (const dir of ['.cache', '.cache/huggingface', '.gradle']) {
        const stat = fs.lstatSync(path.join(jobHome, dir));
        expect([dir, stat.isDirectory(), stat.isSymbolicLink()]).toEqual([dir, true, false]);
      }
      expect(fs.existsSync(path.join(jobHome, '.cache', 'huggingface', 'token'))).toBe(false);
      expect(fs.existsSync(path.join(jobHome, '.cache', 'huggingface', 'stored_tokens'))).toBe(false);
      expect(fs.existsSync(path.join(jobHome, '.gradle', 'gradle.properties'))).toBe(false);
      expect(fs.readFileSync(path.join(jobHome, '.cache', 'huggingface', 'hub', 'model', 'config.json'), 'utf-8')).toBe('{}');
      expect(fs.readlinkSync(path.join(jobHome, '.gradle', 'caches'))).toBe(path.join(realHome, '.gradle', 'caches'));
    });

    it('links a granted directory whole when the credential it could hold is not there', () => {
      plant('.cache/pip/x');
      expect(linkHomeGrants(jobHome, ['~/.cache'], { realHome })).toEqual(['.cache']);
    });

    it("links each entry of the home for a grant of it, but what holds the job's home", () => {
      // The home linked nothing, and a policy granting ~ - which used to
      // reach every toolchain through HOME - found an empty one.
      plant('.npm/x');
      plant('.aws/credentials');
      plant('.localmost/runner/sandbox/1-abc/home/.keep');
      const inside = path.join(realHome, '.localmost', 'runner', 'sandbox', '1-abc', 'home');

      expect(linkHomeGrants(inside, ['~'], { realHome })).toEqual(['.npm']);
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
      plant('Library/Caches/pip/x');
      plant('.npm/x');

      const linked = linkHomeGrants(jobHome, ['~/Library/Caches/pip', '~/.npm'], { realHome });

      expect(linked).toEqual([]);
      expect(fs.readdirSync(elsewhere)).toEqual([]);
      expect(fs.readFileSync(path.join(jobHome, '.npm'), 'utf-8')).toBe('mine');
    });
  });

  describe('createMissingGrantedDirs', () => {
    it('creates a missing granted directory one level at a time, empty, 0755', () => {
      const created = createMissingGrantedDirs(['~/.gradle/caches/', '~/.npm/**'], { realHome });

      expect(created).toEqual([path.join(realHome, '.gradle'), path.join(realHome, '.gradle', 'caches'), path.join(realHome, '.npm')]);
      for (const dir of created) {
        const stat = fs.lstatSync(dir);
        expect(stat.isDirectory()).toBe(true);
        expect(stat.mode & 0o022).toBe(0);
        expect(fs.readdirSync(dir).filter((name) => !created.includes(path.join(dir, name)))).toEqual([]);
      }
    });

    it('creates only the levels above a grant that could name a file', () => {
      // A write grant is a subpath, which can name a file: a directory made
      // at ~/.python_history broke the user's own python, outside any job,
      // with EISDIR. The job can create what its grant names itself; only
      // the levels above, which it is not granted, are the app's to make.
      const logged: string[] = [];
      expect(createMissingGrantedDirs(['~/.python_history', '~/.local/state/tool/history'], { realHome, log: (_l, m) => logged.push(m) }))
        .toEqual([path.join(realHome, '.local'), path.join(realHome, '.local', 'state'), path.join(realHome, '.local', 'state', 'tool')]);
      expect(fs.existsSync(path.join(realHome, '.python_history'))).toBe(false);
      expect(fs.existsSync(path.join(realHome, '.local', 'state', 'tool', 'history'))).toBe(false);
      expect(logged[0]).toBe(
        `Not creating ${path.join(realHome, '.python_history')} for the job: the grant may name a file, which the job can create; end it with / to have a directory made`
      );
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

      const created = createMissingGrantedDirs(['~/.cache/pip/', '~/.m2/repository/'], { realHome, log: (_l, m) => logged.push(m) });

      expect(created).toEqual([]);
      expect(fs.readdirSync(elsewhere)).toEqual([]);
      expect(logged).toHaveLength(2);
    });

    it("creates nothing in or above the app's own directories", () => {
      // A policy can name a path there, which the job is denied anyway; a
      // directory made at a name the app uses - config.yaml - would break it.
      const appDir = path.join(realHome, '.localmost');
      fs.mkdirSync(appDir);
      const logged: string[] = [];
      expect(createMissingGrantedDirs(['~/.localmost/config.yaml/', '~/.localmost/runner/x/'], { realHome, excludeRoots: [appDir], log: (_l, m) => logged.push(m) })).toEqual([]);
      expect(fs.readdirSync(appDir)).toEqual([]);
      expect(logged[0]).toBe(`Not creating ${path.join(appDir, 'config.yaml')} for the job: it is in the app's own directories`);
      expect(createMissingGrantedDirs(['~/.npm/'], { realHome, excludeRoots: [appDir] })).toEqual([path.join(realHome, '.npm')]);
    });

    it("creates nothing in the app's directories or a credential location spelled in another case", () => {
      // The default APFS volume does not tell the cases apart, and this runs
      // outside the sandbox, which closes them in any capitalization.
      const appDir = path.join(realHome, '.localmost');
      fs.mkdirSync(path.join(appDir, 'runner'), { recursive: true });
      fs.mkdirSync(path.join(realHome, '.ssh'));
      const created = createMissingGrantedDirs(['~/.LOCALMOST/runner/broker-sessions.json/', '~/.SSH/sub/'], {
        realHome,
        excludeRoots: [appDir],
        deniedRoots: [path.join(realHome, '.ssh')],
      });
      expect(created).toEqual([]);
      expect(fs.readdirSync(path.join(appDir, 'runner'))).toEqual([]);
      expect(fs.readdirSync(path.join(realHome, '.ssh'))).toEqual([]);
    });

    it('creates nothing in a credential location the job is denied anyway, and says why', () => {
      const logged: string[] = [];
      const deniedRoots = [path.join(realHome, '.ssh'), path.join(realHome, '.aws'), path.join(realHome, '.netrc')];
      expect(createMissingGrantedDirs(['~/.ssh/keys/', '~/.aws/', '~/.netrc'], { realHome, deniedRoots, log: (_l, m) => logged.push(m) })).toEqual([]);
      expect(fs.readdirSync(realHome)).toEqual([]);
      expect(logged).toEqual([
        `Not creating ${path.join(realHome, '.ssh', 'keys')} for the job: the job is denied it whatever it is granted`,
        `Not creating ${path.join(realHome, '.aws')} for the job: the job is denied it whatever it is granted`,
        `Not creating ${path.join(realHome, '.netrc')} for the job: the job is denied it whatever it is granted`,
      ]);
      // A directory that only holds a credential file is still made, even
      // by a grant that could name a file: as a node above a credential it
      // is denied the job's writes, so the job could not make it itself.
      expect(createMissingGrantedDirs(['~/.gradle'], { realHome, deniedRoots: [path.join(realHome, '.gradle', 'gradle.properties')] }))
        .toEqual([path.join(realHome, '.gradle')]);
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

    it('refuses a home that is not a directory of its own', () => {
      const victim = path.join(root, 'victim');
      fs.mkdirSync(victim);
      const linkedHome = path.join(root, 'sandbox', 'linked-home');
      fs.symlinkSync(victim, linkedHome);

      expect(() => prepareJobHome(linkedHome, { grants: [], realHome })).toThrow(/not a directory of its own/);
      expect(fs.readdirSync(victim)).toEqual([]);
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
