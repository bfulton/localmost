import { describe, it, expect } from '@jest/globals';
import { lineSplitter, parseFrame, sanitizeGuestText, MAX_LINE_BYTES } from './ndjson';

describe('lineSplitter', () => {
  it('hands over whole lines however the bytes are split', () => {
    const lines: string[] = [];
    const feed = lineSplitter((line) => lines.push(line), () => lines.push('OVERFLOW'));
    for (const chunk of ['{"a"', ':1}\n{"b":2}\n{"c', '":3}', '\n']) feed(Buffer.from(chunk));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('keeps a multi-byte character split across chunks', () => {
    const lines: string[] = [];
    const bytes = Buffer.from('é\n');
    const feed = lineSplitter((line) => lines.push(line), () => {});
    feed(bytes.subarray(0, 1));
    feed(bytes.subarray(1));
    expect(lines).toEqual(['é']);
  });

  it('never buffers past 64 KiB: a longer line overflows once and nothing more is read', () => {
    const lines: string[] = [];
    let overflows = 0;
    const feed = lineSplitter((line) => lines.push(line), () => overflows++);
    feed(Buffer.alloc(MAX_LINE_BYTES, 'x'));
    expect(overflows).toBe(0);
    feed(Buffer.from('xx'));
    feed(Buffer.from('\n{"after":1}\n'));
    expect(overflows).toBe(1);
    expect(lines).toEqual([]);
  });

  it('takes a line of exactly 64 KiB', () => {
    const lines: string[] = [];
    const feed = lineSplitter((line) => lines.push(line), () => lines.push('OVERFLOW'));
    feed(Buffer.concat([Buffer.alloc(MAX_LINE_BYTES, 'y'), Buffer.from('\n')]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(MAX_LINE_BYTES);
  });
});

describe('parseFrame', () => {
  it('takes only a JSON object stamped v 1', () => {
    expect(parseFrame('{"v":1,"id":2}')).toEqual({ v: 1, id: 2 });
    for (const line of ['{"id":2}', '{"v":2}', '[1]', 'null', 'x', '{"v":"1"}']) expect(parseFrame(line)).toBeNull();
  });
});

describe('sanitizeGuestText', () => {
  it('turns Unicode line breaks and format characters into spaces, which could fake a line or reorder one', () => {
    // U+2028/U+2029 break a line in some viewers; the bidi overrides and
    // isolates (U+202A-U+202E, U+2066-U+2069) and marks (U+200E, U+200F)
    // reorder what a reader sees; a lone surrogate is not text at all.
    expect(sanitizeGuestText('a\u2028b\u2029c')).toBe('a b c');
    expect(sanitizeGuestText('ok \u202Etxt.exe\u202C \u2066x\u2069 \u200E\u200F\uFEFF\u200B')).toBe('ok  txt.exe   x      ');
    expect(sanitizeGuestText('x\uD800y')).toBe('x y');
    // Text outside those classes is left as it is.
    expect(sanitizeGuestText('héllo wörld 日本 😀')).toBe('héllo wörld 日本 😀');
  });

  it('drops ANSI escapes and turns every other control character into a space', () => {
    expect(sanitizeGuestText('\u001b[31mred\u001b[0m ok\r\nnext\u0007\u009b')).toBe('red ok  next  ');
    expect(sanitizeGuestText('\u001b]0;title\u0007after')).toBe('after');
  });

  it('caps the length', () => {
    expect(sanitizeGuestText('a'.repeat(1000), 10)).toBe(`${'a'.repeat(10)}…`);
  });

  it('turns anything that is not a string into one', () => {
    expect(sanitizeGuestText(42)).toBe('42');
  });
});
