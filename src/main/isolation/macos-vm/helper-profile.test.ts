/**
 * The macOS VM helper's seatbelt profiles, rule by rule: each command gets
 * the helper, the files it touches and nothing else.
 */

import { describe, it, expect } from '@jest/globals';
import { buildMacVmProfile, MacVmProfileOptions } from './helper-profile';

const data = '/Users/me/.localmost';
const helper = '/Applications/localmost.app/Contents/Resources/localmost-macvm';
const cache = '/private/var/folders/45/abc_def/C';
const base = { helper, dataDir: data, userCacheDir: cache };
const image = `${data}/macos-vm/images/a1b2c3d4e5f6`;

/** The profile's rules, one string each, comments dropped and whitespace folded. */
const rules = (profile: string): string[] => {
  const body = profile.replace(/;;.*$/gm, '');
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '"') {
      for (i++; i < body.length && body[i] !== '"'; i++) if (body[i] === '\\') i++;
      continue;
    }
    if (body[i] === '(') {
      if (depth === 0) start = i;
      depth++;
    } else if (body[i] === ')' && --depth === 0) {
      out.push(body.slice(start, i + 1).replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')'));
    }
  }
  return out;
};

const profile = (opts: Partial<MacVmProfileOptions> & Pick<MacVmProfileOptions, 'command'>) =>
  rules(buildMacVmProfile({ ...base, ...opts } as MacVmProfileOptions));

const writes = (rs: string[]) => rs.filter((r) => r.includes('file-write'));
const network = (rs: string[]) => rs.filter((r) => r.startsWith('(allow network'));

describe('buildMacVmProfile', () => {
  it('denies by default and lets every command exec only the helper', () => {
    for (const opts of [
      { command: 'catalog' as const },
      { command: 'inspect' as const, ipswName: '25G83.ipsw' },
      { command: 'install' as const, imageId: 'a1b2c3d4e5f6', ipswName: '25G83.ipsw', slot: 1 as const },
      { command: 'provision' as const, imageId: 'a1b2c3d4e5f6', slot: 1 as const },
      { command: 'save-state' as const, imageId: 'a1b2c3d4e5f6', slot: 2 as const },
      { command: 'run' as const, imageId: 'a1b2c3d4e5f6', vmId: '2-0123456789ab', proxyPort: 5000, brokerPort: 8787 },
      { command: 'check' as const, imageId: 'a1b2c3d4e5f6' },
    ]) {
      const rs = profile(opts);
      expect(rs.slice(0, 3)).toEqual(['(version 1)', '(deny default)', '(import "system.sb")']);
      expect(rs.filter((r) => r.includes('process-exec'))).toEqual([`(allow process-exec (literal "${helper}"))`]);
      expect(rs.some((r) => /\(allow (file-read\*|file-write\*|network\*|mach-lookup|iokit-open)\)/.test(r))).toBe(false);
    }
  });

  it('gives the catalog nothing: VZ fetches it in its own service', () => {
    expect(profile({ command: 'catalog' }).slice(4)).toEqual([`(allow file-read* (literal "${helper}"))`]);
  });

  it('lets inspect read the one restore image and hand only it to VZ', () => {
    const rs = profile({ command: 'inspect', ipswName: '25G83.ipsw' });
    expect(rs).toContain(`(allow file-read* (literal "${data}/macos-vm/ipsw/25G83.ipsw"))`);
    expect(rs).toContain(`(allow file-issue-extension (require-all (extension-class "com.apple.app-sandbox.read") (literal "${data}/macos-vm/ipsw/25G83.ipsw")))`);
    expect(writes(rs)).toEqual([]);
  });

  it('lets install write only its image and its slot lock, and read only its restore image', () => {
    const rs = profile({ command: 'install', imageId: 'a1b2c3d4e5f6', ipswName: '25G83.ipsw', slot: 1 });
    expect(writes(rs)).toEqual([
      `(allow file-read* file-write* (subpath "${image}"))`,
      `(allow file-read* file-write* (literal "${data}/macos-vm/slots/1.lock"))`,
    ]);
    expect(rs).toContain(`(allow file-read* (literal "${data}/macos-vm/ipsw") (literal "${data}/macos-vm/ipsw/25G83.ipsw"))`);
    expect(network(rs)).toEqual([]);
  });

  it("gives every VM-booting command the display's IOSurfaces and the helper's own directory listing, nothing wider", () => {
    for (const rs of [
      profile({ command: 'install', imageId: 'a1b2c3d4e5f6', ipswName: '25G83.ipsw', slot: 1 }),
      profile({ command: 'provision', imageId: 'a1b2c3d4e5f6', slot: 1 }),
      profile({ command: 'save-state', imageId: 'a1b2c3d4e5f6', slot: 1 }),
      profile({ command: 'run', imageId: 'a1b2c3d4e5f6', vmId: '1-0123456789ab', proxyPort: 5000, brokerPort: 8787 }),
    ]) {
      expect(rs).toContain('(allow iokit-open (iokit-user-client-class "IOSurfaceRootUserClient"))');
      expect(rs).toContain('(allow file-read* (literal "/Applications/localmost.app/Contents/Resources"))');
      expect(rs.some((r) => r.includes('(subpath "/Applications/localmost.app/Contents/Resources")'))).toBe(false);
      // The display's two per-user caches, Metal's (hex suffix) and macOS 27's
      // ParavirtualizedGraphics (decimal suffix), each read-write and anchored
      // under the user cache dir, in one file-issue-extension rule.
      expect(rs).toContain(
        `(allow file-issue-extension (require-all (extension-class "com.apple.app-sandbox.read-write") ` +
          `(regex #"^/private/var/folders/45/abc_def/C/com[.]apple[.]metal-[0-9a-f]+(/|$)" ` +
          `#"^/private/var/folders/45/abc_def/C/com[.]apple[.]paravirtualizedgraphics-[0-9]+(/|$)")))`
      );
    }
    for (const rs of [profile({ command: 'check', imageId: 'a1b2c3d4e5f6' }), profile({ command: 'inspect', ipswName: '25G83.ipsw' })]) {
      expect(rs.some((r) => r.includes('IOSurface') || r.includes('generic-issue-extension'))).toBe(false);
      // No command that does not boot a VM issues the graphics cache extensions.
      expect(rs.some((r) => r.includes('paravirtualizedgraphics') || r.includes('com[.]apple[.]metal-'))).toBe(false);
    }
  });

  it('opens the window server to provisioning only for the guided window', () => {
    const headless = profile({ command: 'provision', imageId: 'a1b2c3d4e5f6', slot: 1 });
    expect(headless).not.toContain('(allow mach-lookup)');
    expect(headless).not.toContain('(allow file-read*)');
    const guided = profile({ command: 'provision', imageId: 'a1b2c3d4e5f6', slot: 1, window: true });
    expect(guided).toEqual(expect.arrayContaining(['(allow mach-lookup)', '(allow file-read*)']));
    // Still writing only the image and its slot lock.
    expect(writes(guided)).toEqual([
      `(allow file-read* file-write* (subpath "${image}"))`,
      `(allow file-read* file-write* (literal "${data}/macos-vm/slots/1.lock"))`,
    ]);
  });

  it('lets save-state write its image, where the slot directories are, and nothing else', () => {
    const rs = profile({ command: 'save-state', imageId: 'a1b2c3d4e5f6', slot: 2 });
    expect(writes(rs)).toEqual([
      `(allow file-read* file-write* (subpath "${image}"))`,
      `(allow file-read* file-write* (literal "${data}/macos-vm/slots/2.lock"))`,
    ]);
    expect(network(rs)).toEqual([]);
  });

  it('gives a job VM the golden image read-only, its own directory, its slot, and exactly two loopback ports', () => {
    const vm = `${data}/macos-vm/vms/2-0123456789ab`;
    const rs = profile({ command: 'run', imageId: 'a1b2c3d4e5f6', vmId: '2-0123456789ab', proxyPort: 5000, brokerPort: 8787 });
    expect(rs).toContain(`(allow file-read* (subpath "${image}"))`);
    expect(writes(rs)).toEqual([
      `(allow file-read* file-write* (subpath "${vm}"))`,
      `(allow file-read* file-write* (literal "${data}/macos-vm/slots/2.lock"))`,
    ]);
    expect(network(rs)).toEqual([
      '(allow network-outbound (remote ip "localhost:5000"))',
      '(allow network-outbound (remote ip "localhost:8787"))',
      `(allow network-bind network-inbound (subpath "${vm}"))`,
    ]);
  });

  it('lets check only read the image', () => {
    const rs = profile({ command: 'check', imageId: 'a1b2c3d4e5f6' });
    expect(rs.slice(4)).toEqual([`(allow file-read* (literal "${helper}"))`, `(allow file-read* (subpath "${image}"))`]);
  });

  it('refuses what is missing or out of its form rather than writing a wider profile', () => {
    expect(() => buildMacVmProfile({ command: 'run', ...base, imageId: 'a1b2c3d4e5f6', vmId: '1-0123456789ab', proxyPort: 5000 })).toThrow(/broker/);
    expect(() => buildMacVmProfile({ command: 'run', ...base, imageId: 'a1b2c3d4e5f6', vmId: '3-0123456789ab', proxyPort: 5000, brokerPort: 1 })).toThrow();
    expect(() => buildMacVmProfile({ command: 'install', ...base, imageId: 'a1b2c3d4e5f6', ipswName: '../x.ipsw', slot: 1 })).toThrow();
    expect(() => buildMacVmProfile({ command: 'save-state', ...base, imageId: '../../x' as string, slot: 1 })).toThrow();
    expect(() => buildMacVmProfile({ command: 'save-state', ...base, imageId: 'a1b2c3d4e5f6', slot: 3 as 1 })).toThrow();
    expect(() => buildMacVmProfile({ command: 'provision', ...base, userCacheDir: '/private/var/folders/x y/C', imageId: 'a1b2c3d4e5f6', slot: 1 })).toThrow(/regex/);
    expect(() => buildMacVmProfile({ command: 'check', helper: 'relative', dataDir: data, imageId: 'a1b2c3d4e5f6' })).toThrow();
  });

  it('escapes a path so that it cannot close its string', () => {
    const text = buildMacVmProfile({ command: 'check', helper, dataDir: '/Users/a"b\\c', imageId: 'a1b2c3d4e5f6' });
    expect(text).toContain('(subpath "/Users/a\\"b\\\\c/macos-vm/images/a1b2c3d4e5f6")');
  });
});
