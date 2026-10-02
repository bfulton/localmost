import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assertJobTempDir,
  createJobTempDir,
  isJobTempDir,
  jobTempName,
  removeJobTempDir,
  sweepJobTempDirs,
} from './job-temp';

describe("a job's own directory in the per-user temp directory", () => {
  let root: string;
  let userTemp: string;
  let sandboxBase: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-job-temp-')));
    // Stands in for /var/folders/<a>/<b>/T: never the real one, which holds
    // everything else the user runs.
    userTemp = path.join(root, 'folders', 'T');
    sandboxBase = path.join(root, 'runner', 'sandbox');
    fs.mkdirSync(userTemp, { recursive: true });
    fs.mkdirSync(sandboxBase, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const sandbox = (id: string) => path.join(sandboxBase, id);

  describe('jobTempName', () => {
    it("is the sandbox's id, marked as localmost's and as this data directory's", () => {
      const name = jobTempName(sandbox('3-0123456789ab'));
      expect(name).toMatch(/^localmost-[0-9a-f]{8}-3-0123456789ab$/);
      // Another data directory - a development build beside the installed
      // app - names its jobs' directories apart, so neither sweeps the other's.
      expect(jobTempName(path.join(root, 'other', 'sandbox', '3-0123456789ab'))).not.toBe(name);
      expect(jobTempName(sandbox('4-0123456789ab')).split('-')[1]).toBe(name.split('-')[1]);
    });

    it('refuses a directory that is not a sandbox', () => {
      for (const dir of [path.join(sandboxBase, 'x'), path.join(sandboxBase, '1-xyz'), path.join(sandboxBase, '1-0123456789ab', '..')]) {
        expect(() => jobTempName(dir)).toThrow(/not a sandbox/);
      }
    });
  });

  describe('assertJobTempDir', () => {
    it('accepts only <T>/<a job temp name>', () => {
      const dir = path.join(userTemp, jobTempName(sandbox('1-0123456789ab')));
      expect(isJobTempDir(userTemp, dir)).toBe(true);
      expect(() => assertJobTempDir(userTemp, dir)).not.toThrow();
    });

    it.each([
      ['the per-user temp itself', (t: string) => t],
      ['its parent', (t: string) => path.dirname(t)],
      ['/', () => '/'],
      ['a name localmost never makes', (t: string) => path.join(t, 'TemporaryItems')],
      ['a lookalike one level down', (t: string) => path.join(t, 'x', 'localmost-0123abcd-1-0123456789ab')],
      ['a traversal', (t: string) => `${t}/localmost-0123abcd-1-0123456789ab/..`],
      ['a relative path', () => 'localmost-0123abcd-1-0123456789ab'],
      ['a trailing slash', (t: string) => `${t}/localmost-0123abcd-1-0123456789ab/`],
    ])('refuses %s', (_name, of) => {
      const dir = of(userTemp);
      expect(isJobTempDir(userTemp, dir)).toBe(false);
      expect(() => assertJobTempDir(userTemp, dir)).toThrow(/Refusing/);
    });

    it('refuses anything under a directory that is not a per-user temp directory', () => {
      const notT = path.join(root, 'folders');
      expect(isJobTempDir(notT, path.join(notT, 'localmost-0123abcd-1-0123456789ab'))).toBe(false);
      expect(isJobTempDir('', 'localmost-0123abcd-1-0123456789ab')).toBe(false);
    });
  });

  describe('createJobTempDir', () => {
    it('makes it 0700, fresh', () => {
      const dir = createJobTempDir(userTemp, sandbox('1-0123456789ab'));
      expect(path.dirname(dir)).toBe(userTemp);
      const stat = fs.lstatSync(dir);
      expect([stat.isDirectory(), stat.mode & 0o777]).toEqual([true, 0o700]);
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('never takes one that is already there, nor a link at the name', () => {
      const name = jobTempName(sandbox('1-0123456789ab'));
      const elsewhere = path.join(root, 'elsewhere');
      fs.mkdirSync(elsewhere);
      fs.symlinkSync(elsewhere, path.join(userTemp, name));
      expect(() => createJobTempDir(userTemp, sandbox('1-0123456789ab'))).toThrow(/EEXIST/);
    });
  });

  describe('removeJobTempDir', () => {
    it('removes it and what the job left in it, without following a link', async () => {
      const victim = path.join(root, 'victim');
      fs.mkdirSync(victim);
      fs.writeFileSync(path.join(victim, 'keep'), 'kept');
      const dir = createJobTempDir(userTemp, sandbox('1-0123456789ab'));
      fs.mkdirSync(path.join(dir, 'TemporaryItems'));
      fs.writeFileSync(path.join(dir, 'TemporaryItems', 'NSIRD_x'), 'staged');
      fs.symlinkSync(victim, path.join(dir, 'link'));

      await removeJobTempDir(userTemp, dir, sandboxBase);

      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.readFileSync(path.join(victim, 'keep'), 'utf-8')).toBe('kept');
      expect(fs.readdirSync(sandboxBase)).toEqual([]);
    });

    it('moves it out of the per-user temp directory before removing anything in it', async () => {
      // macOS protects a TemporaryItems directory in the per-user temp
      // directory by its path: removed there, the staging directory a job's
      // atomic writes left fails with EPERM, and moved out, it goes.
      const dir = createJobTempDir(userTemp, sandbox('1-0123456789ab'));
      fs.mkdirSync(path.join(dir, 'TemporaryItems'));
      const calls: Array<[string, string[]]> = [];
      for (const op of ['rename', 'rm', 'rmdir', 'unlink'] as const) {
        const real = fs.promises[op].bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
        jest.spyOn(fs.promises, op).mockImplementation(((...args: unknown[]) => {
          calls.push([op, args.filter((a): a is string => typeof a === 'string')]);
          return real(...args);
        }) as never);
      }
      try {
        await removeJobTempDir(userTemp, dir, sandboxBase);
      } finally {
        jest.restoreAllMocks();
      }
      const [[firstOp, [from, to]], ...rest] = calls;
      expect([firstOp, from, path.dirname(to)]).toEqual(['rename', dir, sandboxBase]);
      expect(path.basename(to).startsWith('.removing-')).toBe(true);
      for (const [, paths] of rest) for (const p of paths) expect(p.startsWith(userTemp)).toBe(false);
      expect(fs.readdirSync(userTemp)).toEqual([]);
    });

    it('is done when the directory is already gone', async () => {
      await expect(removeJobTempDir(userTemp, path.join(userTemp, jobTempName(sandbox('1-0123456789ab'))), sandboxBase)).resolves.toBeUndefined();
    });

    it('removes nothing that is not one', async () => {
      fs.writeFileSync(path.join(userTemp, 'someone-elses'), 'kept');
      for (const dir of [userTemp, path.dirname(userTemp), path.join(userTemp, 'someone-elses')]) {
        await expect(removeJobTempDir(userTemp, dir, sandboxBase)).rejects.toThrow(/Refusing/);
      }
      expect(fs.readFileSync(path.join(userTemp, 'someone-elses'), 'utf-8')).toBe('kept');
    });
  });

  describe('sweepJobTempDirs', () => {
    it("removes what this data directory's finished jobs left, and nothing else", async () => {
      const finished = createJobTempDir(userTemp, sandbox('1-0123456789ab'));
      fs.writeFileSync(path.join(finished, 'left'), 'x');
      // A job whose sandbox is still there: something of it may still run.
      fs.mkdirSync(sandbox('2-0123456789ab'));
      const running = createJobTempDir(userTemp, sandbox('2-0123456789ab'));
      // Another data directory's job, and the rest of what lives in T.
      const otherBase = path.join(root, 'other', 'sandbox');
      const others = createJobTempDir(userTemp, path.join(otherBase, '1-0123456789ab'));
      for (const name of ['TemporaryItems', 'com.apple.x', 'localmost-probe', 'tmp.AbCdEfGhIj']) {
        fs.mkdirSync(path.join(userTemp, name));
      }
      const logged: string[] = [];

      await sweepJobTempDirs(userTemp, sandboxBase, (m) => logged.push(m));

      expect(fs.existsSync(finished)).toBe(false);
      expect(fs.readdirSync(userTemp).sort()).toEqual(
        [path.basename(running), path.basename(others), 'TemporaryItems', 'com.apple.x', 'localmost-probe', 'tmp.AbCdEfGhIj'].sort()
      );
      expect(logged).toEqual([expect.stringContaining(path.basename(finished))]);
    });

    it('carries on past one it cannot remove, and says so', async () => {
      const stuck = createJobTempDir(userTemp, sandbox('1-0123456789ab'));
      const gone = createJobTempDir(userTemp, sandbox('2-0123456789ab'));
      // As a home on another volume than the per-user temp would be: the
      // move out fails, and the directory stays for the next sweep.
      const realRename = fs.promises.rename.bind(fs.promises);
      jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (from === stuck) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
        return realRename(from, to);
      });
      const logged: string[] = [];
      try {
        await sweepJobTempDirs(userTemp, sandboxBase, (m) => logged.push(m));
      } finally {
        jest.restoreAllMocks();
      }
      expect(fs.existsSync(stuck)).toBe(true);
      expect(fs.existsSync(gone)).toBe(false);
      expect(logged.some((m) => m.includes('Could not remove') && m.includes(path.basename(stuck)))).toBe(true);
    });
  });
});
