import { policyStamp, repoPolicyRuntime } from './repo-policy';
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

  it('takes denied paths and loopback from the shared section, as a worker is started with', () => {
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

  it('treats an empty loopback list as none', () => {
    // Both open nothing beyond the proxy, and the spawn stamp hashes the
    // value: [] read as a change, retiring every worker spawned without it.
    const empty: LocalmostrcConfig = { version: 1, shared: { network: { loopback: [] } } };
    expect(repoPolicyRuntime(empty, '')).toEqual(repoPolicyRuntime({ version: 1, shared: {} }, ''));
    expect('loopback' in repoPolicyRuntime(empty, '')).toBe(false);
  });

  it('declares nothing denied for a policy that denies nothing', () => {
    const runtime = repoPolicyRuntime({ version: 1, shared: { network: { allow: ['ok.example'] } } }, '');
    expect(runtime.deniedHosts).toEqual([]);
    expect(runtime.denyPaths).toEqual([]);
    expect(runtime.loopback).toBeUndefined();
  });

  it('carries the stamp of the approved policy, the same for every workflow', () => {
    expect(repoPolicyRuntime(approved, 'deploy').stamp).toBe(policyStamp(approved));
    expect(repoPolicyRuntime(approved, '').stamp).toBe(policyStamp(approved));
    expect(repoPolicyRuntime(null, 'deploy').stamp).toBe(policyStamp(null));
  });
});

describe('policyStamp', () => {
  const base: LocalmostrcConfig = {
    version: 1,
    shared: { network: { allow: ['ok.example'] }, env: { allow: ['CI'] } },
    workflows: { deploy: { network: { allow: ['deploy.example'] } } },
  };
  const stamp = (change: (c: LocalmostrcConfig) => void): string => {
    const copy = JSON.parse(JSON.stringify(base)) as LocalmostrcConfig;
    change(copy);
    return policyStamp(copy);
  };

  it('changes with the network, Docker, the filesystem grants and the environment, at any scope', () => {
    // What a worker is started with and keeps, and what it is told to do
    // with its proxy and socket: a change to any of it since the worker
    // started constrains the job the worker claims.
    const before = policyStamp(base);
    for (const change of [
      (c: LocalmostrcConfig) => { c.level = 'moderate'; },
      (c: LocalmostrcConfig) => { c.shared!.network!.allow!.push('more.example'); },
      (c: LocalmostrcConfig) => { c.workflows!.deploy.network = { allow: ['other.example'] }; },
      (c: LocalmostrcConfig) => { c.workflows!.deploy.docker = { pull: { registries: ['docker.io'] } }; },
      (c: LocalmostrcConfig) => { c.shared!.filesystem = { read: ['~/data'] }; },
      (c: LocalmostrcConfig) => { c.shared!.env = { allow: ['CI', 'TOKEN'] }; },
      (c: LocalmostrcConfig) => { c.workflows!.deploy.env = { deny: ['CI'] }; },
    ]) {
      expect(stamp(change)).not.toBe(before);
    }
  });

  it('does not change with what no worker holds: required secrets, loopback, the order of workflows', () => {
    const before = policyStamp(base);
    expect(stamp((c) => { c.workflows!.deploy.secrets = { require: ['KEY'] }; })).toBe(before);
    expect(stamp((c) => { c.shared!.network!.loopback = [5432]; })).toBe(before);
    expect(stamp((c) => { c.workflows = { build: {}, ...c.workflows }; })).toBe(
      stamp((c) => { c.workflows = { ...c.workflows, build: {} }; })
    );
  });

  it('tells no approved policy from one that grants something', () => {
    expect(policyStamp(null)).not.toBe(policyStamp(base));
  });
});
