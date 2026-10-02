'use strict';

// The newc cpio writer for the guest's initramfs files (contract §4.3 step 5).
// Deterministic: entries sorted by the bytes of their names, inode numbers
// given in that order, uid/gid 0, mtime 0, and a gzip wrapper with mtime 0.

const zlib = require('zlib');
const { checkName } = require('./tar');

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const TYPES = new Set([0o100000, S_IFDIR, 0o120000]); // regular file, directory, symlink

function hex8(v) {
  return v.toString(16).toUpperCase().padStart(8, '0');
}

function header(ino, mode, nlink, size, name) {
  const fields = [ino, mode, 0, 0, nlink, 0, size, 0, 0, 0, 0, Buffer.byteLength(name) + 1, 0];
  return Buffer.from('070701' + fields.map(hex8).join(''), 'ascii');
}

/**
 * A newc archive of `entries`, each `{ name, mode, data? }`, where `mode` is
 * a full st_mode (type and permissions): a regular file, a directory, or a
 * symlink whose `data` is its target.
 */
function newc(entries) {
  const seen = new Set();
  for (const e of entries) {
    checkName(e.name);
    if (seen.has(e.name)) throw new Error(`cpio: ${e.name} is listed twice`);
    seen.add(e.name);
    if (!TYPES.has(e.mode & S_IFMT)) throw new Error(`cpio: ${e.name} has an unsupported type`);
  }
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const chunks = [];
  let len = 0;
  const push = (b) => {
    chunks.push(b);
    len += b.length;
  };
  const pad4 = () => {
    if (len % 4) push(Buffer.alloc(4 - (len % 4)));
  };
  const put = (ino, mode, nlink, name, data) => {
    push(header(ino, mode, nlink, data.length, name));
    push(Buffer.from(name + '\0'));
    pad4();
    push(data);
    pad4();
  };
  sorted.forEach((e, i) => {
    const isDir = (e.mode & S_IFMT) === S_IFDIR;
    put(i + 1, e.mode, isDir ? 2 : 1, e.name, isDir ? Buffer.alloc(0) : Buffer.from(e.data ?? Buffer.alloc(0)));
  });
  put(0, 0, 1, 'TRAILER!!!', Buffer.alloc(0));
  return Buffer.concat(chunks);
}

/**
 * gzip at level 9 with a fixed header: mtime 0 (zlib's default) and the OS
 * byte set to 3 (Unix), which zlib otherwise sets from the platform it was
 * built for.
 */
function gzipFixed(buf) {
  const out = zlib.gzipSync(buf, { level: 9 });
  out[9] = 3;
  return out;
}

module.exports = { newc, gzipFixed };
