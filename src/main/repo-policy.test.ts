import { repoPolicyRuntime } from './repo-policy';
import type { LocalmostrcConfig } from '../shared/localmostrc';

describe('repoPolicyRuntime', () => {
  const approved: LocalmostrcConfig = {
    version: 1,
    shared: {
      network: { allow: ['ok.example'], deny: ['bad.example'], loopback: [5432] },
      filesystem: { read: ['~/data'], deny: ['~/data/secret'] },
    },
    workflows: {
      deploy: { network: { deny: ['*.cdn.example'] }, filesystem: { deny: ['~/other'] } },
    },
  };

  it('gives an unapproved commit the baseline: nothing denied, nothing on loopback', () => {
    const runtime = repoPolicyRuntime(null, 'deploy');
    expect(runtime).toMatchObject({ hosts: [], level: 'strict', deniedHosts: [], denyPaths: [] });
    expect(runtime.loopback).toBeUndefined();
  });

  it("resolves denied hosts per workflow, as it resolves the allowed ones", () => {
    expect(repoPolicyRuntime(approved, 'deploy').deniedHosts).toEqual(['bad.example', '*.cdn.example']);
    expect(repoPolicyRuntime(approved, 'build').deniedHosts).toEqual(['bad.example']);
  });

  it('takes denied paths and loopback from the shared section, which the profile is built from', () => {
    const runtime = repoPolicyRuntime(approved, 'deploy');
    expect(runtime.denyPaths).toEqual(['~/data/secret']);
    expect(runtime.loopback).toEqual([5432]);
    // The same for every workflow, or the spawn stamp and the claim's would differ.
    expect(repoPolicyRuntime(approved, '').denyPaths).toEqual(runtime.denyPaths);
  });

  it('passes loopback: true through as every port', () => {
    const all: LocalmostrcConfig = { version: 1, shared: { network: { loopback: true } } };
    expect(repoPolicyRuntime(all, '').loopback).toBe(true);
  });

  it('declares nothing denied for a policy that denies nothing', () => {
    const runtime = repoPolicyRuntime({ version: 1, shared: { network: { allow: ['ok.example'] } } }, '');
    expect(runtime.deniedHosts).toEqual([]);
    expect(runtime.denyPaths).toEqual([]);
    expect(runtime.loopback).toBeUndefined();
  });
});
