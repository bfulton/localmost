'use strict';

// A deterministic tar writer and a tar reader, both in memory.
//
// The guest's root is composed as one tar (the build VM turns it into erofs),
// and apk packages are tars inside gzip members. Nothing here ever extracts
// onto the Mac's filesystem: the volume is case-insensitive and would merge
// names such as xt_DSCP.ko and xt_dscp.ko (contract §4.3 step 5).
//
// Every entry the writer emits is owned by root:root with mtime 0, and the
// entries are sorted by the bytes of their names, so the same input gives the
// same archive. A name or link target that does not fit the ustar fields gets
// a PAX extended header.

const BLOCK = 512;

const TYPE_FLAG = { file: '0', link: '1', symlink: '2', dir: '5' };
const FLAG_TYPE = { '0': 'file', '\0': 'file', '1': 'link', '2': 'symlink', '5': 'dir' };

/** Throws unless `name` is a relative, normalised path: no empty, `.` or `..` component. */
function checkName(name) {
  if (typeof name !== 'string' || name === '' || name.startsWith('/') || name.includes('\0')) {
    throw new Error(`tar: bad entry name ${JSON.stringify(name)}`);
  }
  for (const part of name.split('/')) {
    if (part === '' || part === '.' || part === '..') {
      throw new Error(`tar: bad entry name ${JSON.stringify(name)}`);
    }
  }
}

function octal(value, width) {
  // width includes the terminating NUL.
  const s = value.toString(8);
  if (s.length > width - 1) throw new Error(`tar: ${value} does not fit ${width - 1} octal digits`);
  return s.padStart(width - 1, '0') + '\0';
}

function header({ name, typeflag, mode, size, linkname }) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii'); // uid
  h.write(octal(0, 8), 116, 'ascii'); // gid
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(0, 12), 136, 'ascii'); // mtime
  h.fill(0x20, 148, 156); // checksum field counts as spaces
  h.write(typeflag, 156, 'ascii');
  if (linkname) h.write(linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write('root', 265, 32, 'ascii');
  h.write('root', 297, 32, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

function pad(len) {
  const rem = len % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem);
}

/** One PAX record: "<len> key=value\n", where <len> counts the whole record. */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len += 1;
  return `${len}${body}`;
}

const fitsUstar = (s) => Buffer.byteLength(s) <= 100 && /^[\x20-\x7e]*$/.test(s);

/**
 * Writes `items` as one tar archive. Each item is
 * `{ name, type: 'file'|'dir'|'symlink'|'link', mode, data?, linkname? }`.
 * Directories are written with a trailing `/`, as GNU tar writes them.
 */
function writeTar(items) {
  const seen = new Set();
  for (const it of items) {
    checkName(it.name);
    if (seen.has(it.name)) throw new Error(`tar: ${it.name} is listed twice`);
    seen.add(it.name);
    if (!TYPE_FLAG[it.type]) throw new Error(`tar: ${it.name} has unknown type ${it.type}`);
  }
  const sorted = [...items].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const chunks = [];
  for (const it of sorted) {
    const name = it.type === 'dir' ? `${it.name}/` : it.name;
    const data = it.type === 'file' ? Buffer.from(it.data) : Buffer.alloc(0);
    const linkname = it.type === 'symlink' || it.type === 'link' ? it.linkname : '';
    if ((it.type === 'symlink' || it.type === 'link') && !linkname) {
      throw new Error(`tar: ${it.name} has no link target`);
    }
    const pax = [];
    if (!fitsUstar(name)) pax.push(paxRecord('path', name));
    if (linkname && !fitsUstar(linkname)) pax.push(paxRecord('linkpath', linkname));
    if (pax.length) {
      const body = Buffer.from(pax.join(''));
      const paxName = `PaxHeaders/${String(chunks.length)}`;
      chunks.push(header({ name: paxName, typeflag: 'x', mode: 0o644, size: body.length }), body, pad(body.length));
    }
    const shortName = fitsUstar(name) ? name : Buffer.from(name).subarray(0, 100).toString('latin1').replace(/[^\x20-\x7e]/g, '_');
    const shortLink = fitsUstar(linkname) ? linkname : '';
    chunks.push(
      header({ name: shortName, typeflag: TYPE_FLAG[it.type], mode: it.mode & 0o7777, size: data.length, linkname: shortLink }),
      data,
      pad(data.length),
    );
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

function cstring(buf, start, len) {
  const s = buf.subarray(start, start + len);
  const nul = s.indexOf(0);
  return (nul === -1 ? s : s.subarray(0, nul)).toString('utf8');
}

function parseOctal(buf, start, len) {
  const s = cstring(buf, start, len).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error(`tar: bad octal field ${JSON.stringify(s)}`);
  return parseInt(s, 8);
}

function parsePax(body) {
  const out = {};
  let off = 0;
  while (off < body.length) {
    const space = body.indexOf(0x20, off);
    if (space === -1) break;
    const len = parseInt(body.subarray(off, space).toString('ascii'), 10);
    if (!Number.isInteger(len) || len <= 0 || off + len > body.length) throw new Error('tar: bad PAX record');
    const rec = body.subarray(space + 1, off + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    off += len;
  }
  return out;
}

/**
 * Reads every entry of a tar archive in memory. It stops at the end blocks or
 * at the end of the buffer (an apk's signature segment has no end blocks).
 * Returns `[{ name, type, mode, uid, gid, mtime, size, data, linkname, pax }]`,
 * with `type` one of file, dir, symlink, link, or the raw flag for anything
 * else (a device or fifo), which the caller refuses. PAX and GNU long-name
 * headers are applied to the entry that follows them.
 */
function readTar(buf) {
  const entries = [];
  let off = 0;
  let pending = {};
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== parseOctal(h, 148, 8)) throw new Error(`tar: header checksum mismatch at offset ${off}`);
    const flag = String.fromCharCode(h[156]);
    const size = parseOctal(h, 124, 12);
    const bodyStart = off + BLOCK;
    const body = buf.subarray(bodyStart, bodyStart + size);
    if (body.length !== size) throw new Error('tar: truncated entry');
    off = bodyStart + Math.ceil(size / BLOCK) * BLOCK;
    if (flag === 'x') {
      pending = { ...pending, ...parsePax(body) };
      continue;
    }
    if (flag === 'g') continue;
    if (flag === 'L' || flag === 'K') {
      pending = { ...pending, [flag === 'L' ? 'path' : 'linkpath']: cstring(body, 0, body.length) };
      continue;
    }
    const prefix = cstring(h, 345, 155);
    let name = pending.path ?? (prefix ? `${prefix}/${cstring(h, 0, 100)}` : cstring(h, 0, 100));
    const type = FLAG_TYPE[flag] ?? flag;
    if (name.startsWith('./')) name = name.slice(2);
    if (type === 'dir' && name.endsWith('/')) name = name.slice(0, -1);
    entries.push({
      name,
      type,
      mode: parseOctal(h, 100, 8),
      uid: parseOctal(h, 108, 8),
      gid: parseOctal(h, 116, 8),
      mtime: parseOctal(h, 136, 12),
      size,
      data: type === 'file' ? body : Buffer.alloc(0),
      linkname: pending.linkpath ?? cstring(h, 157, 100),
      pax: pending,
    });
    pending = {};
  }
  return entries;
}

module.exports = { writeTar, readTar, checkName };
