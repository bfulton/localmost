'use strict';

const zlib = require('zlib');
const { unzboot } = require('./unzboot');

/** An arm64 Image: 64-byte header with the "ARMd" magic at 0x38, then a body. */
function fakeImage() {
  const img = Buffer.alloc(4096, 0xab);
  img.fill(0, 0, 64);
  img.write('ARMd', 0x38, 'latin1');
  return img;
}

/** An EFI zboot PE: "MZ", "zimg" at 4, payload offset and size at 8 and 12, compression name at 24. */
function fakeZboot({ image = fakeImage(), magic = 'zimg', comp = 'gzip', payload } = {}) {
  const body = payload ?? zlib.gzipSync(image);
  const head = Buffer.alloc(256);
  head.write('MZ', 0, 'latin1');
  head.write(magic, 4, 'latin1');
  head.writeUInt32LE(head.length, 8);
  head.writeUInt32LE(body.length, 12);
  head.write(comp, 24, 'latin1');
  return Buffer.concat([head, body, Buffer.alloc(64)]);
}

describe('unzboot', () => {
  it('unpacks the gzip payload at the recorded offset and size', () => {
    const image = fakeImage();
    expect(unzboot(fakeZboot({ image })).equals(image)).toBe(true);
  });

  it('refuses a file without the zimg magic', () => {
    expect(() => unzboot(fakeZboot({ magic: 'zimX' }))).toThrow(/zimg/);
  });

  it('refuses a compression other than gzip', () => {
    expect(() => unzboot(fakeZboot({ comp: 'zstd' }))).toThrow(/gzip/);
  });

  it('refuses a payload without the arm64 ARMd magic', () => {
    const notArm = Buffer.alloc(4096);
    expect(() => unzboot(fakeZboot({ image: notArm }))).toThrow(/ARMd/);
  });

  it('refuses a payload that runs past the end of the file', () => {
    const pe = fakeZboot();
    pe.writeUInt32LE(pe.length, 12);
    expect(() => unzboot(pe)).toThrow(/past the end/);
  });
});
