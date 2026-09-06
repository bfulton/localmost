import { describe, it, expect } from '@jest/globals';
import { describePolicy, POLICY_SECTION_KEYS, WORKFLOW_POLICY_KEYS } from './policy-describe';

/**
 * A section declaring something under every key a policy may carry. The guard
 * test below leans on it: whatever the grammar grows, it has to appear here
 * and it has to come back out of describePolicy.
 */
const everything = {
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
      'CI', 'AWS_SECRET_ACCESS_KEY', 'docker.io', 'alpine:3', 'vk-*', 'DEPLOY_KEY',
    ]) {
      expect(text).toContain(value);
    }
  });

  it('covers every key the grammar accepts, so a new one cannot be enforced unseen', () => {
    // The defect this guards: a key that validates and is enforced but that no
    // renderer prints is approved without being read. It has happened twice -
    // `docker:` was missing from the CLI, `env:` from the app.
    for (const key of WORKFLOW_POLICY_KEYS) {
      const only = { [key]: (everything as Record<string, unknown>)[key] };
      expect(describePolicy(only).length).toBeGreaterThan(0);
    }
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
