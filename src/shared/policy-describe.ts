/**
 * One description of a policy, for everything that shows one to a person.
 *
 * There were three renderers before this: the CLI's `policy show`, the app's
 * approval summary, and the diff. Each enumerated the policy keys by hand, and
 * each left out a different one - `docker:` never printed in the CLI, `env:`
 * never printed in the app, and the app still described `sockets:`, a key the
 * grammar had stopped accepting. A grant that is enforced but never rendered
 * is approved without being read, which is the whole failure this file exists
 * to prevent.
 *
 * So the keys are enumerated once, here. Presentation stays with the caller:
 * `group` and `marker` are for a grouped, coloured listing, `summary` is the
 * flat one-line form. Adding a key to the grammar means adding it here, and
 * the guard test in policy-describe.test.ts fails until it is.
 */

import { DockerPolicy, describeDockerGrants } from './docker-policy';
import { SandboxPolicyLevel } from './types';

/**
 * Every key a .localmostrc may declare at the top of the file. The parser
 * refuses any other, and every one that is not structure has to be described.
 */
export const LOCALMOSTRC_KEYS = ['version', 'level', 'shared', 'workflows'] as const;

/** Every key a policy section may declare at any scope. */
export const POLICY_SECTION_KEYS = ['network', 'filesystem', 'env', 'docker'] as const;

/**
 * What a workflow-scoped policy may declare on top of those: which secrets the
 * workflow requires, which is a grant like any other and is shown like one.
 */
export const WORKFLOW_POLICY_KEYS = [...POLICY_SECTION_KEYS, 'secrets'] as const;

export type PolicySectionKey = (typeof POLICY_SECTION_KEYS)[number];

/**
 * Every key describePolicy has to render: the section keys, plus the level,
 * which is declared once at the top of the file but widens every section.
 */
export const DESCRIBED_POLICY_KEYS = [...WORKFLOW_POLICY_KEYS, 'level'] as const;

/** A section of a policy, as the grammar accepts it. */
export interface DescribablePolicy {
  /** Top of the file only; a caller describing the whole policy passes it in. */
  level?: SandboxPolicyLevel;
  network?: { allow?: string[]; deny?: string[] };
  filesystem?: { read?: string[]; write?: string[]; deny?: string[] };
  env?: { allow?: string[]; deny?: string[] };
  docker?: DockerPolicy;
  /** Workflow scope only. */
  secrets?: { require?: string[] };
}

export interface PolicyGrant {
  /** Heading for a grouped listing, printed once per run of grants. */
  group: string;
  /** Single character marking what the entry does: + grant, - deny, r/w access. */
  marker: string;
  /** The declared value, as written, with what it means when that is not obvious. */
  value: string;
  /** The flat one-line form, already prefixed. */
  summary: string;
}

/**
 * What a level grants beyond strict. Strict is the baseline and has no entry:
 * it grants nothing a policy has to be approved for.
 */
const LEVEL_GRANTS: Record<Exclude<SandboxPolicyLevel, 'strict'>, string> = {
  moderate: 'adds common package registries, toolchain locations and writable package-manager caches',
  permissive: 'allows every network host, plus toolchain locations and writable package-manager caches',
};

export function describePolicy(policy: DescribablePolicy, prefix = ''): PolicyGrant[] {
  const grants: PolicyGrant[] = [];
  const add = (group: string, marker: string, label: string, values: string[] | undefined) => {
    for (const value of values ?? []) {
      grants.push({ group, marker, value, summary: `${prefix}${label}: ${value}` });
    }
  };

  // First, because it widens everything listed after it. It was once left
  // out entirely, and `level: permissive` described as granting nothing.
  if (policy.level && policy.level !== 'strict') {
    add('Level', '+', 'level', [`${policy.level} (${LEVEL_GRANTS[policy.level]})`]);
  }

  add('Network allow', '+', 'network', policy.network?.allow);
  add('Network deny', '-', 'network denied', policy.network?.deny);
  add('Filesystem read', 'r', 'read', policy.filesystem?.read);
  add('Filesystem write', 'w', 'write', policy.filesystem?.write);
  add('Filesystem deny', '-', 'denied', policy.filesystem?.deny);
  add('Environment allow', '+', 'env', policy.env?.allow);
  add('Environment deny', '-', 'env denied', policy.env?.deny);

  add('Secrets required', '+', 'secret', policy.secrets?.require);

  // Docker describes itself: what a container grant means is the docker
  // grammar's business, and the line it produces is already the flat form.
  for (const grant of describeDockerGrants(policy.docker, '')) {
    grants.push({ group: 'Docker', marker: '+', value: grant, summary: `${prefix}${grant}` });
  }

  return grants;
}
