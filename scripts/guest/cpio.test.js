'use strict';

const zlib = require('zlib');
const { newc, gzipFixed } = require('./cpio');

// One newc header, written out by hand from the format: magic, then 13
// fields of 8 hex digits (ino, mode, uid, gid, nlink, mtime, filesize,
// devmajor, devminor, rdevmajor, rdevminor, namesize, check).
function hdr(ino, mode, nlink, size, name) {
  const f = [ino, mode, 0, 0, nlink, 0, size, 0, 0, 0, 0, Buffer.byteLength(name) + 1, 0];
  return '070701' + f.map((v) => v.toString(16).toUpperCase().padStart(8, '0')).join('');
}
const pad4 = (s) => s + '\0'.repeat((4 - (s.length % 4)) % 4);

describe('newc', () => {
  const entries = [
    { name: 'init', mode: 0o100755, data: Buffer.from('hi') },
    { name: 'bin', mode: 0o040755 },
    { name: 'sh', mode: 0o120777, data: Buffer.from('bin/busybox') },
  ];

  it('writes a byte-exact newc archive: sorted, uid/gid 0, mtime 0, then the trailer', () => {
    const expected =
      pad4(hdr(1, 0o040755, 2, 0, 'bin') + 'bin\0') +
      pad4(hdr(2, 0o100755, 1, 2, 'init') + 'init\0') +
      pad4('hi') +
      pad4(hdr(3, 0o120777, 1, 11, 'sh') + 'sh\0') +
      pad4('bin/busybox') +
      pad4(hdr(0, 0, 1, 0, 'TRAILER!!!') + 'TRAILER!!!\0');
    expect(newc(entries).toString('latin1')).toBe(expected);
  });

  it('is identical on a second run and for any input order', () => {
    expect(newc(entries).equals(newc([...entries].reverse()))).toBe(true);
  });

  it('encodes directories with nlink 2 and symlinks with their target as the data', () => {
    const out = newc(entries).toString('latin1');
    expect(out).toContain(hdr(1, 0o040755, 2, 0, 'bin'));
    expect(out).toContain(hdr(3, 0o120777, 1, 11, 'sh') + 'sh\0');
  });

  it('refuses bad or duplicate names', () => {
    expect(() => newc([{ name: '/abs', mode: 0o100644, data: Buffer.alloc(0) }])).toThrow(/name/);
    expect(() => newc([{ name: 'a', mode: 0o040755 }, { name: 'a', mode: 0o040755 }])).toThrow(/twice/);
  });

  it('refuses an entry named after the trailer, which would end the archive early', () => {
    expect(() => newc([{ name: 'TRAILER!!!', mode: 0o100644, data: Buffer.alloc(0) }, ...entries])).toThrow(
      /end-of-archive/,
    );
  });
});

describe('gzipFixed', () => {
  it('gives the same bytes every time, with mtime 0 and the Unix OS byte', () => {
    const a = gzipFixed(Buffer.from('payload'));
    expect(a.equals(gzipFixed(Buffer.from('payload')))).toBe(true);
    expect(a.readUInt32LE(4)).toBe(0);
    expect(a[9]).toBe(3);
    expect(zlib.gunzipSync(a).toString()).toBe('payload');
  });
});
