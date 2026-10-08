import { describe, it, expect } from '@jest/globals';
import { cleanText } from './clean-text';

describe('cleanText', () => {
  it('removes ANSI escapes and control characters, and collapses whitespace', () => {
    expect(cleanText('\x1b[31mred\x1b[0m\r\nnext\tline\x07\x00end')).toBe('red next line end');
    expect(cleanText('title\x1b]0;owned\x07 after')).toBe('title after');
    expect(cleanText(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c\x85d`)).toBe('a b c d');
  });

  it('cuts the text to its bound', () => {
    expect(cleanText('x'.repeat(600))).toBe(`${'x'.repeat(512)}…`);
    expect(cleanText('abcdef', 3)).toBe('abc…');
  });
});
