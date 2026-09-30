'use strict';

const { parseCheckConfig, daemonFixture } = require('./build-guest');

describe('daemonFixture', () => {
  it('records the smoke answers with the image they came from and how to regenerate them', () => {
    const smoke = {
      hello: { ok: true },
      timings: { helloMs: 1 },
      docker: { engine: '29.5.3', minApiVersion: '1.40' },
      baseline: { ServerVersion: '29.5.3' },
      answers: { ping: { status: 200, headers: {}, body: 'OK' } },
    };
    const manifest = { guestVersion: '2026.10.0', artifacts: { 'rootfs.erofs': { sha256: 'ab'.repeat(32), size: 1 } } };
    const f = daemonFixture(smoke, manifest);
    expect(Object.keys(f)).toEqual(['comment', 'guestVersion', 'docker', 'baseline', 'answers']);
    expect(f.comment).toContain(`rootfs.erofs sha256 ${'ab'.repeat(32)}`);
    expect(f.comment).toContain('npm run build:guest -- --write-fixture');
    expect(f.guestVersion).toBe('2026.10.0');
    expect(f.docker).toBe(smoke.docker);
    expect(f.baseline).toBe(smoke.baseline);
    expect(f.answers).toBe(smoke.answers);
  });
});

function report(lines) {
  const flags = Array.from({ length: 24 }, (_, i) => `- CONFIG_FLAG_${i}: enabled`);
  return ['info: reading kernel config ...', '', 'Generally Necessary:', '- cgroup hierarchy: nonexistent??', ...flags, ...lines, '', 'Optional Features:', '- CONFIG_USER_NS: missing', ''].join('\n');
}

describe('parseCheckConfig', () => {
  it('passes a report whose generally necessary options are all enabled, as a module or built in', () => {
    const r = parseCheckConfig(report(['- CONFIG_VETH: enabled (as module)', '- CONFIG_NET_NS: enabled']));
    expect(r.missing).toEqual([]);
    expect(r.checked).toBe(26);
  });

  it('names each missing option, ignoring colour codes and the optional section', () => {
    const r = parseCheckConfig(report(['- \x1b[1mCONFIG_BRIDGE\x1b[0m: \x1b[1;31mmissing\x1b[0m']));
    expect(r.missing).toEqual(['CONFIG_BRIDGE']);
  });

  it('refuses a report without the section, or with too few options to be real', () => {
    expect(() => parseCheckConfig('nothing here')).toThrow(/Generally Necessary/);
    expect(() => parseCheckConfig('Generally Necessary:\n- CONFIG_A: enabled\nOptional Features:\n')).toThrow(/only 1/);
  });
});
