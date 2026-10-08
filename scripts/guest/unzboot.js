'use strict';

// Unpacks Alpine's EFI zboot vmlinuz into the raw arm64 Image that
// VZLinuxBootLoader boots (contract §4.3 step 2). The PE file carries the
// magic "zimg" at offset 4, the payload's offset and size (u32 LE) at 8 and
// 12, and the compression name, NUL padded, at 24.

const zlib = require('zlib');

function unzboot(pe) {
  if (pe.length < 64 || pe.toString('latin1', 0, 2) !== 'MZ' || pe.toString('latin1', 4, 8) !== 'zimg') {
    throw new Error('unzboot: not an EFI zboot image (no MZ/zimg magic)');
  }
  const offset = pe.readUInt32LE(8);
  const size = pe.readUInt32LE(12);
  const nameEnd = pe.indexOf(0, 24);
  const comp = pe.toString('latin1', 24, nameEnd === -1 || nameEnd > 32 ? 32 : nameEnd);
  if (comp !== 'gzip') throw new Error(`unzboot: payload compression is ${JSON.stringify(comp)}, not gzip`);
  if (offset + size > pe.length || size === 0) throw new Error('unzboot: payload runs past the end of the file');
  const image = zlib.gunzipSync(pe.subarray(offset, offset + size));
  if (image.length < 64 || image.toString('latin1', 0x38, 0x3c) !== 'ARMd') {
    throw new Error('unzboot: payload is not an arm64 Image (no ARMd magic at 0x38)');
  }
  return image;
}

module.exports = { unzboot };
