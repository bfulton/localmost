/**
 * Tests for reading a network entry: a host or *.suffix, optionally with a
 * port. The proxy's own decisions are tested in proxy-server.test.ts.
 */

import { hostPatternMatches, parseHostPattern } from './egress-screen';

describe('parseHostPattern', () => {
  it.each([
    ['github.com', { host: 'github.com', wildcard: false, port: undefined }],
    ['GitHub.com', { host: 'github.com', wildcard: false, port: undefined }],
    ['*.example.com', { host: '.example.com', wildcard: true, port: undefined }],
    ['svc.example.com:8443', { host: 'svc.example.com', wildcard: false, port: 8443 }],
    ['*.example.com:8080', { host: '.example.com', wildcard: true, port: 8080 }],
    ['2606:4700::1111', { host: '2606:4700::1111', wildcard: false, port: undefined }],
    ['[2606:4700::1111]', { host: '2606:4700::1111', wildcard: false, port: undefined }],
    ['[2606:4700::1111]:8443', { host: '2606:4700::1111', wildcard: false, port: 8443 }],
  ])('reads %s', (entry, expected) => {
    expect(parseHostPattern(entry)).toEqual(expected);
  });

  it.each(['svc.example.com:https', 'svc.example.com:0', 'svc.example.com:65536', 'svc.example.com:', 'svc.example.com:-1', '[::1]:x'])(
    'marks the port of %s as not a port',
    (entry) => {
      expect(parseHostPattern(entry).port).toBeNull();
    }
  );
});

describe('hostPatternMatches', () => {
  const matches = (entry: string, host: string) => hostPatternMatches(parseHostPattern(entry), host);

  it('matches an exact host whatever its case', () => {
    expect(matches('GitHub.com', 'github.COM')).toBe(true);
    expect(matches('github.com', 'notgithub.com')).toBe(false);
  });

  it('matches a wildcard below its suffix but not the suffix itself', () => {
    expect(matches('*.example.com', 'a.b.example.com')).toBe(true);
    expect(matches('*.example.com', 'example.com')).toBe(false);
    expect(matches('*.example.com', 'badexample.com')).toBe(false);
  });

  it('matches the host of an entry that spells a port, leaving the port to the caller', () => {
    expect(matches('svc.example.com:8443', 'svc.example.com')).toBe(true);
    expect(matches('[2606:4700::1111]:8443', '2606:4700::1111')).toBe(true);
  });
});
