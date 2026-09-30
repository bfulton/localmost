/**
 * The helper's seatbelt profile, rule by rule (contract §2.5).
 *
 * The helper runs VZ, whose service reaches the share only through a sandbox
 * extension the helper issues. So the profile is the second layer of the
 * share rule: it grants the one real directory, and issuing extensions for
 * that directory alone. These tests hold it to exactly that.
 */

import { describe, it, expect } from '@jest/globals';
import { buildHelperProfile, HelperProfileOptions } from './helper-profile';

const data = '/Users/me/.localmost';
const job: HelperProfileOptions = {
  mode: 'job',
  helper: '/Applications/localmost.app/Contents/Resources/localmost-vm',
  resources: '/Applications/localmost.app/Contents/Resources',
  dataDir: data,
  vmId: '3-0123456789ab',
  sandboxId: '3-abcdefabcdef',
  proxyPort: 51234,
};
const refresh: HelperProfileOptions = {
  mode: 'refresh',
  helper: job.helper,
  resources: job.resources,
  dataDir: data,
  vmId: '0-0123456789ab',
  repoKey: '0123456789abcdef',
};
const share = `${data}/runner/sandbox/3-abcdefabcdef/_work`;
const vmDir = (vmId: string) => `${data}/vm/jobs/${vmId}`;

/** The profile's rules, one string each, comments dropped and whitespace folded. */
const rules = (profile: string): string[] => {
  const body = profile.replace(/;;.*$/gm, '');
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '"') {
      // Skip a string, honouring its escapes.
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

/** Every string literal in the profile, unescaped. */
const strings = (profile: string): string[] =>
  [...profile.replace(/;;.*$/gm, '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));

describe('buildHelperProfile in job mode', () => {
  const profile = buildHelperProfile(job);

  it('is exactly the contract profile for a job VM', () => {
    expect(rules(profile)).toEqual([
      '(version 1)',
      '(deny default)',
      '(import "system.sb")',
      `(allow process-exec (literal "${job.helper}"))`,
      `(allow file-read* (literal "${job.helper}") (subpath "${job.resources}/guest"))`,
      `(allow file-read* file-write* (subpath "${vmDir(job.vmId)}"))`,
      `(allow file-read* file-write* (subpath "${share}"))`,
      '(allow file-issue-extension (require-all (extension-class "com.apple.app-sandbox.read-write" "com.apple.app-sandbox.read") ' +
        `(subpath "${share}")))`,
      '(allow generic-issue-extension (extension-class "com.apple.virtualization.extension.fuse"))',
      '(allow network-outbound (remote ip "localhost:51234"))',
      `(allow network-bind network-inbound (subpath "${vmDir(job.vmId)}"))`,
    ]);
  });

  it('issues extensions for the share alone, of both classes, and nothing else', () => {
    const issuing = rules(profile).filter((r) => r.includes('file-issue-extension'));
    expect(issuing).toHaveLength(1);
    expect(issuing[0]).toContain(`(subpath "${share}")`);
    expect(issuing[0]).toContain('"com.apple.app-sandbox.read-write"');
    expect(issuing[0]).toContain('"com.apple.app-sandbox.read"');
    expect(issuing[0]).toContain('require-all');
  });

  it('execs and reads only the helper it names', () => {
    expect(rules(profile).filter((r) => r.includes('process-exec'))).toEqual([`(allow process-exec (literal "${job.helper}"))`]);
    const other = buildHelperProfile({ ...job, helper: '/Users/me/src/localmost/build/localmost-vm' });
    expect(other).toContain('(allow process-exec (literal "/Users/me/src/localmost/build/localmost-vm"))');
    expect(other).not.toContain(job.helper);
  });

  it('reaches the worker proxy port on loopback, and no other address', () => {
    const outbound = rules(buildHelperProfile({ ...job, proxyPort: 8080 })).filter((r) => r.includes('network-outbound'));
    expect(outbound).toEqual(['(allow network-outbound (remote ip "localhost:8080"))']);
  });

  it('grants nothing in <data> but its own VM directory and the share', () => {
    for (const value of strings(profile).filter((s) => s.startsWith(`${data}/`) || s === data)) {
      const ok = value === share || value === vmDir(job.vmId) || value.startsWith(`${vmDir(job.vmId)}/`);
      expect([value, ok]).toEqual([value, true]);
    }
  });
});

describe('buildHelperProfile in refresh mode', () => {
  const profile = buildHelperProfile(refresh);

  it('is exactly the contract profile for a refresh VM: no share, no extension rule, no network', () => {
    expect(rules(profile)).toEqual([
      '(version 1)',
      '(deny default)',
      '(import "system.sb")',
      `(allow process-exec (literal "${refresh.helper}"))`,
      `(allow file-read* (literal "${refresh.helper}") (subpath "${refresh.resources}/guest"))`,
      `(allow file-read* file-write* (subpath "${vmDir(refresh.vmId)}"))`,
      `(allow file-read* file-write* (literal "${data}/vm/cache/0123456789abcdef/data.img.new"))`,
      '(allow generic-issue-extension (extension-class "com.apple.virtualization.extension.fuse"))',
      `(allow network-bind network-inbound (subpath "${vmDir(refresh.vmId)}"))`,
    ]);
    expect(profile).not.toContain('file-issue-extension');
    expect(profile).not.toContain('network-outbound');
  });

  it('grants nothing in <data> but its own VM directory and the one disk it refreshes', () => {
    for (const value of strings(profile).filter((s) => s.startsWith(`${data}/`))) {
      const ok =
        value === `${data}/vm/cache/0123456789abcdef/data.img.new` ||
        value === vmDir(refresh.vmId) ||
        value.startsWith(`${vmDir(refresh.vmId)}/`);
      expect([value, ok]).toEqual([value, true]);
    }
    // Not the golden disk every job clones, nor anything else of the cache.
    expect(profile).not.toContain(`"${data}/vm/cache/0123456789abcdef/data.img"`);
    expect(profile).not.toContain(`(subpath "${data}/vm/cache`);
  });
});

describe('what buildHelperProfile refuses to build', () => {
  it('escapes the paths it interpolates, as the job profile does', () => {
    const odd = buildHelperProfile({ ...job, dataDir: '/Users/a"b\\c/.localmost', resources: '/R"es' });
    expect(odd).toContain('(subpath "/R\\"es/guest")');
    expect(odd).toContain('(subpath "/Users/a\\"b\\\\c/.localmost/vm/jobs/3-0123456789ab")');
    expect(strings(odd)).toContain('/Users/a"b\\c/.localmost/runner/sandbox/3-abcdefabcdef/_work');
  });

  it('takes ids, never a path, and checks each against its form', () => {
    expect(() => buildHelperProfile({ ...job, vmId: '../../x' })).toThrow(/vm id/);
    expect(() => buildHelperProfile({ ...job, sandboxId: '3-abc/../..' })).toThrow(/sandbox id/);
    expect(() => buildHelperProfile({ ...refresh, repoKey: '../cache' })).toThrow(/repository key/);
  });

  it('keeps slot 0 for refresh VMs and job slots for job VMs', () => {
    expect(() => buildHelperProfile({ ...job, vmId: '0-0123456789ab' })).toThrow(/slot/);
    expect(() => buildHelperProfile({ ...refresh, vmId: '3-0123456789ab' })).toThrow(/slot/);
  });

  it('requires what each mode needs and refuses what it does not use', () => {
    expect(() => buildHelperProfile({ ...job, sandboxId: undefined })).toThrow(/sandbox/);
    expect(() => buildHelperProfile({ ...job, proxyPort: undefined })).toThrow(/proxy port/);
    expect(() => buildHelperProfile({ ...job, repoKey: '0123456789abcdef' })).toThrow(/refresh/);
    expect(() => buildHelperProfile({ ...refresh, repoKey: undefined })).toThrow(/repository key/);
    expect(() => buildHelperProfile({ ...refresh, sandboxId: '3-abcdefabcdef' })).toThrow(/job/);
    expect(() => buildHelperProfile({ ...refresh, proxyPort: 51234 })).toThrow(/job/);
  });

  it('refuses a proxy port that is not one', () => {
    for (const proxyPort of [0, 65536, 1.5, -1, NaN]) {
      expect(() => buildHelperProfile({ ...job, proxyPort })).toThrow(/proxy port/);
    }
  });

  it('refuses a relative path', () => {
    expect(() => buildHelperProfile({ ...job, helper: 'build/localmost-vm' })).toThrow(/absolute/);
    expect(() => buildHelperProfile({ ...job, resources: 'build' })).toThrow(/absolute/);
    expect(() => buildHelperProfile({ ...job, dataDir: '.localmost' })).toThrow(/absolute/);
  });
});
