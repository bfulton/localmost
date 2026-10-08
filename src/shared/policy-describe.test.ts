import { describe, it, expect } from '@jest/globals';
import {
  describePolicy,
  DESCRIBED_POLICY_KEYS,
  LOCALMOSTRC_KEYS,
  POLICY_SECTION_KEYS,
  POLICY_SECTION_SUBKEYS,
  WORKFLOW_POLICY_KEYS,
} from './policy-describe';
import { MODERATE_NETWORK_ALLOWLIST, RUNNER_INFRASTRUCTURE_ALLOWLIST } from './network-allowlist';

/**
 * A section declaring something under every key a policy may carry. The guard
 * test below leans on it: whatever the grammar grows, it has to appear here
 * and it has to come back out of describePolicy.
 */
const everything = {
  level: 'permissive' as const,
  network: { allow: ['github.com'], deny: ['evil.example'] },
  filesystem: { read: ['/etc'], write: ['~/.npm'], deny: ['~/.ssh'] },
  env: { allow: ['CI'], deny: ['AWS_SECRET_ACCESS_KEY'] },
  docker: {
    pull: { registries: ['docker.io'] },
    run: { images: ['alpine:3'], mounts: [{ path: './', mode: 'ro' as const }], networks: [{ name: 'vk-*', internal: true }] },
    build: { context: './docker', tags: ['myapp:*'] },
  },
  secrets: { require: ['DEPLOY_KEY'] },
};

describe('describePolicy', () => {
  it('names every value the policy declares, whatever key it sits under', () => {
    const text = describePolicy(everything).map((g) => `${g.group} ${g.marker} ${g.value} ${g.summary}`).join('\n');
    for (const value of [
      'github.com', 'evil.example', '/etc', '~/.npm', '~/.ssh',
      'CI', 'AWS_SECRET_ACCESS_KEY', 'docker.io', 'alpine:3', 'vk-*', './docker', 'myapp:*', 'DEPLOY_KEY', 'permissive',
    ]) {
      expect(text).toContain(value);
    }
  });

  it('covers every key the grammar accepts, so a new one cannot be enforced unseen', () => {
    // The defect this guards: a key that validates and is enforced but that no
    // renderer prints is approved without being read. It has happened twice -
    // `docker:` was missing from the CLI, `env:` from the app.
    for (const key of DESCRIBED_POLICY_KEYS) {
      const only = { [key]: (everything as Record<string, unknown>)[key] };
      expect(describePolicy(only).length).toBeGreaterThan(0);
    }
    // The level is the largest grant a policy can make. It sits at the top of
    // the file rather than in a section, which is how it came to be enforced
    // and never shown - `level: permissive` alone described as nothing.
    expect(DESCRIBED_POLICY_KEYS).toContain('level');
  });

  it('covers every key a section accepts, so a new one cannot be enforced unseen', () => {
    for (const [section, keys] of Object.entries(POLICY_SECTION_SUBKEYS)) {
      const declared = (everything as Record<string, unknown>)[section] as Record<string, unknown>;
      for (const key of keys) {
        expect(declared).toHaveProperty(key);
        expect(describePolicy({ [section]: { [key]: declared[key] } }).length).toBeGreaterThan(0);
      }
    }
  });

  it('describes every top-level key that is not structure, so a new one cannot grant unseen', () => {
    const structural = ['version', 'shared', 'workflows'];
    for (const key of LOCALMOSTRC_KEYS) {
      if (structural.includes(key)) continue;
      expect(DESCRIBED_POLICY_KEYS).toContain(key);
    }
  });

  it('puts a loosened level first, ahead of the grants it makes larger', () => {
    for (const level of ['moderate', 'permissive'] as const) {
      const grants = describePolicy({ level, network: { allow: ['github.com'] } });
      expect(grants[0].group).toBe('Level');
      expect(grants[0].summary).toMatch(new RegExp(`^level: ${level}\\b`));
    }
    expect(describePolicy({ level: 'permissive' })[0].summary).toMatch(/every network host/);
  });

  it('names what a loosened level opens, not just that it is common', () => {
    // "Common package registries" read as a narrow grant. Moderate also opens
    // whole CDN domains and GitHub content hosts anyone can publish to. A
    // job's VM has a home and toolchains of its own, so a level is only its
    // proxy's.
    const [moderate] = describePolicy({ level: 'moderate' });
    const wildcards = MODERATE_NETWORK_ALLOWLIST.filter(
      (host) => host.startsWith('*.') && !RUNNER_INFRASTRUCTURE_ALLOWLIST.includes(host)
    );
    expect(wildcards).toEqual(expect.arrayContaining(['*.cloudfront.net', '*.fastly.net']));
    for (const host of [...wildcards, 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'codeload.github.com']) {
      expect(moderate.summary).toContain(host);
    }

    for (const level of ['moderate', 'permissive'] as const) {
      const [grant] = describePolicy({ level });
      expect(grant.summary).not.toMatch(/~\/|toolchain|localmost test/);
    }
    expect(describePolicy({ level: 'permissive' })[0].summary).toMatch(/allows every network host/);
  });

  it('says that a job with a Docker grant is refused until the Docker relay exists, on every Docker line', () => {
    const grants = describePolicy({ docker: everything.docker });
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      expect(grant.note).toMatch(/refused until localmost has a Docker relay/);
      expect(grant.summary).toMatch(/\(a job with a Docker grant is refused until localmost has a Docker relay into the job's macOS VM\)$/);
    }
  });

  it('says nothing for strict, which is the baseline and grants nothing extra', () => {
    expect(describePolicy({ level: 'strict' })).toEqual([]);
  });

  it('keeps the workflow-only key out of the shared list, which is what validation scopes on', () => {
    expect(POLICY_SECTION_KEYS).not.toContain('secrets');
    expect(WORKFLOW_POLICY_KEYS).toContain('secrets');
  });

  it('describes nothing for an empty section', () => {
    expect(describePolicy({})).toEqual([]);
  });

  it('warns on a write to a place something outside the sandbox acts on', () => {
    const [grant] = describePolicy({ filesystem: { write: ['~/Library/LaunchAgents'] } });
    expect(grant.warning).toMatch(/launchd/);
    expect(grant.summary).toMatch(/^write: ~\/Library\/LaunchAgents \(not applied yet.*\) \(warning: launchd runs/);
  });

  it('warns on a write to the home directory itself', () => {
    expect(describePolicy({ filesystem: { write: ['~'] } })[0].summary).toMatch(/warning: your whole home directory/);
  });

  it('does not warn on an ordinary write, or on a read of a sensitive place', () => {
    const grants = describePolicy({ filesystem: { write: ['~/.npm', './build'], read: ['~/Library/LaunchAgents'] } });
    expect(grants.map((g) => g.warning)).toEqual([undefined, undefined, undefined]);
    expect(grants.map((g) => g.summary).join('\n')).not.toMatch(/warning/);
  });

  it('says a deny is enforced, even where an allow or the level would let it through', () => {
    // Deny lists used to be merged and shown but never applied, so a
    // reviewer read a denial that did not exist. Both are enforced now.
    const grants = describePolicy({ network: { deny: ['bad.example'] }, filesystem: { deny: ['~/.aws'] } });
    expect(grants[0].summary).toMatch(/^network denied: bad\.example \(refused even where an allow or the level/);
    // A job's VM sees none of this Mac's filesystem yet, the denied path included.
    expect(grants[1].summary).toMatch(/^denied: ~\/\.aws \(nothing of this Mac's filesystem reaches a job's macOS VM yet; once VM shares exist, no read or write inside a granted path\)$/);
  });

  it('says which workflow-scoped grants the runner cannot apply', () => {
    // The environment is fixed when a worker starts, before the workflow is
    // known, so a per-workflow env allow was listed as a grant the runner
    // never made; and a job's VM is given no filesystem grants yet.
    const grants = describePolicy(
      {
        network: { allow: ['api.example.com'] },
        filesystem: { read: ['/opt/x'], write: ['./out'], deny: ['~/.aws'] },
        env: { allow: ['FASTLANE_*'], deny: ['AWS_*'] },
      },
      'deploy: ',
      'workflow'
    );
    const line = (value: string) => grants.find((g) => g.value === value)!.summary;
    expect(line('api.example.com')).toBe('deploy: network: api.example.com');
    for (const value of ['/opt/x', './out']) {
      expect(line(value)).toMatch(/\(not applied yet: a job's macOS VM is given no filesystem grants until VM shares exist\)$/);
    }
    expect(line('~/.aws')).toMatch(/\(nothing of this Mac's filesystem reaches a job's macOS VM yet/);
    expect(line('FASTLANE_*')).toMatch(/\(not applied: the environment is fixed when the worker starts.*declare it under shared:\)$/);
    expect(line('AWS_*')).toMatch(/\(applied to every job, not only this workflow's/);
  });

  it('says nothing of scope for the same grants under shared:, but that a job is not given the filesystem yet', () => {
    const grants = describePolicy({ filesystem: { write: ['./out'] }, env: { allow: ['CI'], deny: ['AWS_*'] } });
    expect(grants.map((g) => g.summary)).toEqual([`write: ./out (not applied yet: a job's macOS VM is given no filesystem grants until VM shares exist)`, 'env: CI', 'env denied: AWS_*']);
  });

  it('prefixes the flat summary, which is how a workflow scope is shown', () => {
    const [grant] = describePolicy({ network: { allow: ['github.com'] } }, 'ci: ');
    expect(grant.summary).toBe('ci: network: github.com');
  });
});
