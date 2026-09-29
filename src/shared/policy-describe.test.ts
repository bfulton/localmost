import { describe, it, expect } from '@jest/globals';
import {
  describePolicy,
  DESCRIBED_POLICY_KEYS,
  LOCALMOSTRC_KEYS,
  POLICY_SECTION_KEYS,
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
  },
  secrets: { require: ['DEPLOY_KEY'] },
};

describe('describePolicy', () => {
  it('names every value the policy declares, whatever key it sits under', () => {
    const text = describePolicy(everything).map((g) => `${g.group} ${g.marker} ${g.value} ${g.summary}`).join('\n');
    for (const value of [
      'github.com', 'evil.example', '/etc', '~/.npm', '~/.ssh',
      'CI', 'AWS_SECRET_ACCESS_KEY', 'docker.io', 'alpine:3', 'vk-*', 'DEPLOY_KEY', 'permissive',
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
    // whole CDN domains and GitHub content hosts anyone can publish to, and
    // both levels make toolchain trees in the home directory writable, some
    // of them on the user's PATH.
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
      for (const dir of ['~/.cargo', '~/.local', '~/go', '~/Library/Caches']) {
        expect(grant.summary).toContain(dir);
      }
      expect(grant.summary).toMatch(/PATH/);
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

  it('prefixes the flat summary, which is how a workflow scope is shown', () => {
    const [grant] = describePolicy({ network: { allow: ['github.com'] } }, 'ci: ');
    expect(grant.summary).toBe('ci: network: github.com');
  });
});
