/**
 * The `isolation:` key of a .localmostrc: an ordered list of the isolation
 * types a repository accepts, under `shared:` and per workflow.
 */

import { describe, it, expect } from '@jest/globals';
import {
  diffConfigs,
  effectiveIsolation,
  formatPolicyDiff,
  getEffectivePolicy,
  LocalmostrcConfig,
  parseLocalmostrcContent,
  serializeLocalmostrc,
} from './localmostrc';
import { approvalStamp } from './policy-store';
import type { IsolationDeclaration } from './isolation';

const parse = (body: string) => parseLocalmostrcContent(`version: 1\n${body}`);
const messages = (body: string) => parse(body).errors.map((e) => e.message);

describe('isolation in a .localmostrc', () => {
  it('is accepted under shared and per workflow, as any, a single type or an ordered list', () => {
    const result = parse(
      'shared:\n  isolation: [macos-vm, seatbelt]\n' +
        'workflows:\n  ui:\n    isolation: seatbelt\n  build:\n    isolation: any\n'
    );
    expect(result.errors).toEqual([]);
    expect(result.config?.shared?.isolation).toEqual(['macos-vm', 'seatbelt']);
    expect(result.config?.workflows?.ui.isolation).toBe('seatbelt');
    expect(result.config?.workflows?.build.isolation).toBe('any');
  });

  it('accepts a type this build cannot run yet: it is filtered when a job is admitted', () => {
    expect(parse('shared:\n  isolation: macos-vm\n').errors).toEqual([]);
    expect(parse('shared:\n  isolation: [service-account, macos-vm]\n').errors).toEqual([]);
  });

  it('refuses an unknown type, with the accepted ones in the message', () => {
    expect(messages('shared:\n  isolation: docker\n')).toEqual([
      'shared.isolation: "docker" is not an isolation type. Accepted: seatbelt, service-account, macos-vm, or any.',
    ]);
    expect(messages('workflows:\n  ci:\n    isolation: [seatbelt, container]\n')).toEqual([
      'workflows.ci.isolation[1]: "container" is not an isolation type. Accepted: seatbelt, service-account, macos-vm.',
    ]);
  });

  it('refuses a type listed twice, any inside a list, and an empty list', () => {
    expect(messages('shared:\n  isolation: [seatbelt, seatbelt]\n')).toEqual(['shared.isolation lists seatbelt twice']);
    expect(messages('shared:\n  isolation: [any, seatbelt]\n')).toEqual([
      'shared.isolation[0]: "any" stands alone: write isolation: any, or list the types in order.',
    ]);
    expect(messages('shared:\n  isolation: []\n')).toEqual([
      'shared.isolation must list at least one isolation type, or be any',
    ]);
  });
});

describe('effectiveIsolation', () => {
  const config: LocalmostrcConfig = {
    version: 1,
    shared: { isolation: ['macos-vm', 'seatbelt'] },
    workflows: { ui: { isolation: 'seatbelt' }, build: { network: { allow: ['github.com'] } } },
  };

  it("is the workflow's list when it declares one, replacing shared's", () => {
    expect(effectiveIsolation(config, 'ui')).toEqual(['seatbelt']);
  });

  it("is shared's for a workflow that declares none, or none known", () => {
    expect(effectiveIsolation(config, 'build')).toEqual(['macos-vm', 'seatbelt']);
    expect(effectiveIsolation(config, 'other')).toEqual(['macos-vm', 'seatbelt']);
    expect(effectiveIsolation(config, undefined)).toEqual(['macos-vm', 'seatbelt']);
  });

  it('is any when nothing declares it, or there is no policy at all', () => {
    expect(effectiveIsolation({ version: 1 }, 'ci')).toEqual(['macos-vm', 'service-account', 'seatbelt']);
    expect(effectiveIsolation(null, 'ci')).toEqual(['macos-vm', 'service-account', 'seatbelt']);
  });

  it('is what getEffectivePolicy carries too', () => {
    expect(getEffectivePolicy(config, 'ui').isolation).toBe('seatbelt');
    expect(getEffectivePolicy(config, 'build').isolation).toEqual(['macos-vm', 'seatbelt']);
    expect(getEffectivePolicy({ version: 1 }, 'build')).not.toHaveProperty('isolation');
  });
});

describe('isolation written back', () => {
  it('round-trips as written: any, a single type, a list in its order', () => {
    const config: LocalmostrcConfig = {
      version: 1,
      shared: { isolation: ['service-account', 'seatbelt'] },
      workflows: { ui: { isolation: 'seatbelt' }, build: { isolation: 'any' } },
    };
    const written = serializeLocalmostrc(config);
    const reparsed = parseLocalmostrcContent(written);
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.config).toEqual(config);
  });
});

describe('isolation in the approval', () => {
  const withShared = (isolation: IsolationDeclaration): LocalmostrcConfig => ({ version: 1, shared: { isolation } });

  it('shows a change to the shared list, order included', () => {
    const diffs = diffConfigs(withShared(['macos-vm', 'seatbelt']), withShared(['seatbelt', 'macos-vm']));
    expect(diffs).toEqual([
      { path: 'shared.isolation', type: 'changed', oldValue: 'macos-vm, seatbelt', newValue: 'seatbelt, macos-vm' },
    ]);
    expect(formatPolicyDiff(diffs)).toBe('~ shared.isolation: macos-vm, seatbelt -> seatbelt, macos-vm');
  });

  it('shows a list replacing the default, and reads an absent one as any', () => {
    expect(diffConfigs({ version: 1 }, withShared('seatbelt'))).toEqual([
      { path: 'shared.isolation', type: 'changed', oldValue: 'any (macos-vm, service-account, seatbelt)', newValue: 'seatbelt' },
    ]);
    // Nothing changes what a job can get, so nothing to approve.
    expect(diffConfigs({ version: 1 }, withShared('any'))).toEqual([]);
  });

  it("shows a workflow's list added, removed or changed", () => {
    const before: LocalmostrcConfig = { version: 1, workflows: { ui: { isolation: 'seatbelt' }, old: { isolation: 'macos-vm' } } };
    const after: LocalmostrcConfig = { version: 1, workflows: { ui: { isolation: ['macos-vm', 'seatbelt'] }, old: {}, new: { isolation: 'seatbelt' } } };
    expect(diffConfigs(before, after)).toEqual(
      expect.arrayContaining([
        { path: 'workflows.ui.isolation', type: 'changed', oldValue: 'seatbelt', newValue: 'macos-vm, seatbelt' },
        { path: 'workflows.old.isolation', type: 'removed', oldValue: 'macos-vm' },
        { path: 'workflows.new.isolation', type: 'added', newValue: 'seatbelt' },
      ])
    );
    expect(diffConfigs(before, after)).toHaveLength(3);
  });

  it('is part of the stamp an approval is given for', () => {
    expect(approvalStamp('o/r', withShared('seatbelt'))).not.toBe(approvalStamp('o/r', withShared('macos-vm')));
    expect(approvalStamp('o/r', withShared(['seatbelt', 'macos-vm']))).not.toBe(
      approvalStamp('o/r', withShared(['macos-vm', 'seatbelt']))
    );
  });
});
