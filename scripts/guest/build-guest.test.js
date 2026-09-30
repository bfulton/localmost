'use strict';

const { parseCheckConfig } = require('./build-guest');

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
