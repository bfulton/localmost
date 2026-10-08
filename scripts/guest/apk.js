'use strict';

// Reading Alpine apk (v2) packages in memory.
//
// An apk is three gzip members concatenated: a signature tar, a control tar
// holding .PKGINFO, and the data tar. The APKINDEX records, per package, the
// SHA-1 of the control member's bytes ("Q1" + base64), and .PKGINFO's
// `datahash` is the SHA-256 of the data member's bytes, so a package can be
// tied to a signed index without trusting anything inside it (contract §4.2).

const crypto = require('crypto');
const zlib = require('zlib');
const { readTar } = require('./tar');

const FTEXT = 1, FHCRC = 2, FEXTRA = 4, FNAME = 8, FCOMMENT = 16;

/** Where the deflate stream of the gzip member at `off` starts. */
function deflateStart(buf, off) {
  if (buf[off] !== 0x1f || buf[off + 1] !== 0x8b || buf[off + 2] !== 8) {
    throw new Error(`not a gzip member at offset ${off}`);
  }
  const flags = buf[off + 3];
  if (flags & ~(FTEXT | FHCRC | FEXTRA | FNAME | FCOMMENT)) throw new Error('gzip: reserved flags set');
  let p = off + 10;
  if (flags & FEXTRA) p += 2 + buf.readUInt16LE(p);
  if (flags & FNAME) p = buf.indexOf(0, p) + 1;
  if (flags & FCOMMENT) p = buf.indexOf(0, p) + 1;
  if (flags & FHCRC) p += 2;
  if (p <= off || p > buf.length) throw new Error('gzip: truncated header');
  return p;
}

/**
 * Splits a buffer of concatenated gzip members. Returns
 * `[{ raw, data }]`: each member's own bytes and what they decompress to.
 */
function gzipMembers(buf) {
  const members = [];
  let off = 0;
  while (off < buf.length) {
    const start = deflateStart(buf, off);
    const { buffer: data, engine } = zlib.inflateRawSync(buf.subarray(start), { info: true });
    const end = start + engine.bytesWritten;
    if (end + 8 > buf.length) throw new Error('gzip: truncated trailer');
    if (buf.readUInt32LE(end) !== zlib.crc32(data)) throw new Error('gzip: CRC mismatch');
    if (buf.readUInt32LE(end + 4) !== (data.length >>> 0)) throw new Error('gzip: size mismatch');
    members.push({ raw: buf.subarray(off, end + 8), data });
    off = end + 8;
  }
  return members;
}

function parsePkginfo(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([a-z_]+) = (.*)$/.exec(line);
    if (m && !(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

function segments(apk) {
  const members = gzipMembers(apk);
  if (members.length !== 3) throw new Error(`apk: expected 3 gzip segments, found ${members.length}`);
  const [, control, data] = members;
  const pk = readTar(control.data).find((e) => e.name === '.PKGINFO');
  if (!pk) throw new Error('apk: no .PKGINFO in the control segment');
  return { control, data, pkginfo: parsePkginfo(pk.data.toString('utf8')) };
}

/** The data tar's entries, and the control fields. Nothing is written to disk. */
function readApk(apk) {
  const { data, pkginfo } = segments(apk);
  return { entries: readTar(data.data), pkginfo };
}

/**
 * Throws unless the control segment's SHA-1 equals the index's `C:` value
 * (`Q1<base64>`) and the data segment's SHA-256 equals .PKGINFO's datahash.
 */
function verifyApk(apk, indexChecksum) {
  const { control, data, pkginfo } = segments(apk);
  const q1 = 'Q1' + crypto.createHash('sha1').update(control.raw).digest('base64');
  if (q1 !== indexChecksum) throw new Error(`apk: control segment ${q1} does not match the index (${indexChecksum})`);
  const datahash = crypto.createHash('sha256').update(data.raw).digest('hex');
  if (datahash !== pkginfo.datahash) throw new Error('apk: data segment does not match the control datahash');
  return pkginfo;
}

module.exports = { gzipMembers, readApk, verifyApk, parsePkginfo };
