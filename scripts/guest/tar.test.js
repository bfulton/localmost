'use strict';

const { writeTar, readTar } = require('./tar');

const file = (name, data, mode = 0o644) => ({ name, type: 'file', mode, data: Buffer.from(data) });

describe('writeTar', () => {
  it('writes every entry as root:root with mtime 0, in sorted order', () => {
    const out = writeTar([
      file('usr/bin/b', 'bee'),
      { name: 'usr', type: 'dir', mode: 0o755 },
      file('etc/a', 'a'),
    ]);
    const entries = readTar(out);
    expect(entries.map((e) => e.name)).toEqual(['etc/a', 'usr', 'usr/bin/b']);
    for (const e of entries) {
      expect(e.uid).toBe(0);
      expect(e.gid).toBe(0);
      expect(e.mtime).toBe(0);
    }
    expect(entries[2].data.toString()).toBe('bee');
    expect(entries[1].type).toBe('dir');
  });

  it('sorts by bytes, so case variants stay distinct and in a fixed order', () => {
    const entries = readTar(writeTar([file('x/xt_dscp.ko', 'lower'), file('x/xt_DSCP.ko', 'upper')]));
    expect(entries.map((e) => [e.name, e.data.toString()])).toEqual([
      ['x/xt_DSCP.ko', 'upper'],
      ['x/xt_dscp.ko', 'lower'],
    ]);
  });

  it('is the same bytes whatever order the entries came in', () => {
    const a = [file('b', '2'), file('a', '1'), { name: 'l', type: 'symlink', mode: 0o777, linkname: 'a' }];
    expect(writeTar(a).equals(writeTar([...a].reverse()))).toBe(true);
  });

  it('uses a PAX header for a name or link target past the ustar fields', () => {
    const long = 'usr/lib/' + 'd'.repeat(120) + '/file.so';
    const target = '../' + 't'.repeat(130);
    const entries = readTar(
      writeTar([file(long, 'x'), { name: 'lnk', type: 'symlink', mode: 0o777, linkname: target }]),
    );
    expect(entries.find((e) => e.type === 'file').name).toBe(long);
    expect(entries.find((e) => e.type === 'symlink').linkname).toBe(target);
    // The raw archive carries a PAX extended header ('x') for each.
    const raw = writeTar([file(long, 'x')]);
    expect(String.fromCharCode(raw[156])).toBe('x');
  });

  it('encodes symlinks and hard links with their targets', () => {
    const entries = readTar(
      writeTar([
        file('sbin/mke2fs', 'elf'),
        { name: 'sbin/mkfs.ext4', type: 'link', mode: 0o755, linkname: 'sbin/mke2fs' },
        { name: 'var/run', type: 'symlink', mode: 0o777, linkname: '../run' },
      ]),
    );
    expect(entries.find((e) => e.name === 'var/run')).toMatchObject({ type: 'symlink', linkname: '../run' });
    expect(entries.find((e) => e.name === 'sbin/mkfs.ext4')).toMatchObject({ type: 'link', linkname: 'sbin/mke2fs' });
  });

  it('ends with two zero blocks and pads to 512 bytes', () => {
    const out = writeTar([file('a', 'hello')]);
    expect(out.length % 512).toBe(0);
    expect(out.subarray(out.length - 1024).every((b) => b === 0)).toBe(true);
  });

  it('refuses names that are absolute, empty, dotted or duplicated', () => {
    for (const name of ['/etc/a', '', 'a/../b', './a', 'a//b']) {
      expect(() => writeTar([file(name, 'x')])).toThrow(/name/);
    }
    expect(() => writeTar([file('a', 'x'), file('a', 'y')])).toThrow(/twice/);
  });
});

describe('readTar', () => {
  it('rejects a header whose checksum is wrong', () => {
    const out = Buffer.from(writeTar([file('a', 'x')]));
    out[0] = 'b'.charCodeAt(0);
    expect(() => readTar(out)).toThrow(/checksum/);
  });

  it('reads a partial tar with no end blocks, as an apk signature segment is', () => {
    const out = writeTar([file('a', 'x')]);
    expect(readTar(out.subarray(0, 1024)).map((e) => e.name)).toEqual(['a']);
  });
});
