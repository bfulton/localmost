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
import { MODERATE_NETWORK_ALLOWLIST, RUNNER_INFRASTRUCTURE_ALLOWLIST } from './network-allowlist';
import { sensitiveWriteReason } from './sensitive-paths';

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

/**
 * Every key each section may declare inside it. The parser refuses any other,
 * as it does at the levels above: a misspelled `lookback:` or `denny:` would
 * otherwise read as a grant or a protection and be neither. Docker has a
 * grammar of its own, closed in docker-policy.
 */
export const POLICY_SECTION_SUBKEYS = {
  network: ['allow', 'deny', 'loopback'],
  filesystem: ['read', 'write', 'deny'],
  env: ['allow', 'deny'],
  secrets: ['require'],
} as const;

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
  /** `loopback` is shared-scope only; validation refuses it in a workflow. */
  network?: { allow?: string[]; deny?: string[]; loopback?: true | number[] };
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
  /** What the entry does that its bare value would not say. */
  note?: string;
  /**
   * Why this grant reaches past the job, when it does: a write to a place
   * something outside the sandbox later acts on. Allowed, but called out.
   */
  warning?: string;
  /** The flat one-line form, already prefixed, with the note and warning. */
  summary: string;
}

/**
 * Hosts in the moderate allowlist that serve whatever anyone publishes, so a
 * job can fetch or send nearly anything through them. Named only while the
 * allowlist still holds them.
 */
const CONTENT_HOSTS = ['codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com'];

/** Whole domains moderate opens, read from the list the proxy enforces. */
const MODERATE_WILDCARDS = MODERATE_NETWORK_ALLOWLIST.filter(
  (host) => host.startsWith('*.') && !RUNNER_INFRASTRUCTURE_ALLOWLIST.includes(host)
);

// Mirrors the home-directory toolchain paths process-sandbox makes writable
// at moderate and permissive. Some hold binaries on the user's PATH, which is
// why a write there outlives the job. Change both together.
// Both loosened levels read the toolchains installed in the home directory,
// and point package managers at a cache of the target's own that stays
// writable across jobs - so what one job leaves there, the next one runs.
// The home trees themselves are never writable: some are on the user's PATH.
const HOME_TOOLCHAIN_ACCESS =
  'read access to toolchains in your home (~/.cargo, ~/.rustup, ~/.local, ~/go, ~/.dotnet, ~/.gradle, ~/.m2, ' +
  "~/Library/Caches), and a package-manager cache shared by this target's jobs, pull requests included, " +
  'when the tool cache is persistent';

/**
 * What a level grants beyond strict. Strict is the baseline and has no entry:
 * it grants nothing a policy has to be approved for.
 */
const LEVEL_GRANTS: Record<Exclude<SandboxPolicyLevel, 'strict'>, string> = {
  moderate:
    `adds package registries, every host under ${MODERATE_WILDCARDS.join(', ')}, and GitHub content hosts ` +
    `(${CONTENT_HOSTS.filter((host) => MODERATE_NETWORK_ALLOWLIST.includes(host)).join(', ')}) - ` +
    `CDNs and content hosts anyone can publish to - plus ${HOME_TOOLCHAIN_ACCESS}`,
  permissive: `allows every network host, plus ${HOME_TOOLCHAIN_ACCESS}`,
};

/**
 * Where a section sits. A worker's sandbox profile and environment are fixed
 * when it starts, before the runner knows which workflow it will run, so a
 * workflow section's filesystem grants and env allow are never applied to a
 * runner job - and a workflow's env deny is applied to every job, to be safe.
 * Listing them as plain grants told the reviewer something untrue.
 */
export type PolicyScope = 'shared' | 'workflow';

/** A loopback grant as the entries a diff compares: each port, or every one. */
export function loopbackValues(loopback: true | number[] | undefined): string[] | undefined {
  if (loopback === undefined) return undefined;
  return loopback === true ? ['every port'] : loopback.map(String);
}

// A job otherwise reaches nothing on loopback but its own proxy. Services
// that listen there - a dev database, a debugger on 9229, a browser's remote
// debugging on 9222, another job's test server - mostly trust whoever can
// connect, so this is shown as a warning, not a plain grant.
const LOOPBACK_ALL =
  "the job can connect to any service listening on this Mac's loopback interface - local databases, " +
  "debuggers, dev servers, other jobs' test servers - without going through its proxy";
const LOOPBACK_PORTS =
  'the job can connect to local services listening on these ports on this Mac, without going through its proxy';

const FILESYSTEM_NOT_APPLIED =
  'not applied to runner jobs: their filesystem is fixed when the worker starts, before the workflow is known; ' +
  'only localmost test applies it';
const ENV_ALLOW_NOT_APPLIED =
  'not applied: the environment is fixed when the worker starts, before the workflow is known; declare it under shared:';
const ENV_DENY_EVERYWHERE =
  "applied to every job, not only this workflow's: the environment is fixed when the worker starts";

export function describePolicy(policy: DescribablePolicy, prefix = '', scope: PolicyScope = 'shared'): PolicyGrant[] {
  const perWorkflow = scope === 'workflow';
  const grants: PolicyGrant[] = [];
  const add = (
    group: string,
    marker: string,
    label: string,
    values: string[] | undefined,
    how: { note?: string; warn?: (value: string) => string | undefined } = {}
  ) => {
    const { note } = how;
    for (const value of values ?? []) {
      const warning = how.warn?.(value);
      const summary =
        `${prefix}${label}: ${value}` + (note ? ` (${note})` : '') + (warning ? ` (warning: ${warning})` : '');
      grants.push({ group, marker, value, ...(note ? { note } : {}), ...(warning ? { warning } : {}), summary });
    }
  };

  // First, because it widens everything listed after it. It was once left
  // out entirely, and `level: permissive` described as granting nothing.
  if (policy.level && policy.level !== 'strict') {
    add('Level', '+', 'level', [`${policy.level} (${LEVEL_GRANTS[policy.level]})`]);
  }

  add('Network allow', '+', 'network', policy.network?.allow);
  // A deny is checked ahead of every grant, so it holds against an allow
  // that would cover it, and against the level. Runner infrastructure is
  // the one exception on the network side: the runner cannot work without it.
  // On the filesystem side the profile re-allows the job's own sandbox and
  // its target's caches after the policy's deny, so neither can be denied.
  add('Network deny', '-', 'network denied', policy.network?.deny, {
    note: 'refused even where an allow or the level would let it through; runner infrastructure excepted',
  });
  const filesystemNote = perWorkflow ? FILESYSTEM_NOT_APPLIED : undefined;
  const loopback = policy.network?.loopback;
  if (loopback === true) {
    add('Network loopback', '+', 'loopback', ['every port'], { warn: () => LOOPBACK_ALL });
  } else if (loopback?.length) {
    const ports = `${loopback.length === 1 ? 'port' : 'ports'} ${loopback.join(', ')}`;
    add('Network loopback', '+', 'loopback', [ports], { warn: () => LOOPBACK_PORTS });
  }
  add('Filesystem read', 'r', 'read', policy.filesystem?.read, { note: filesystemNote });
  add('Filesystem write', 'w', 'write', policy.filesystem?.write, {
    note: filesystemNote,
    warn: (value) => sensitiveWriteReason(value),
  });
  add('Filesystem deny', '-', 'denied', policy.filesystem?.deny, {
    note: filesystemNote ?? "no read or write, even inside a granted path; the job's own sandbox and caches excepted",
  });
  add('Environment allow', '+', 'env', policy.env?.allow, { note: perWorkflow ? ENV_ALLOW_NOT_APPLIED : undefined });
  add('Environment deny', '-', 'env denied', policy.env?.deny, { note: perWorkflow ? ENV_DENY_EVERYWHERE : undefined });

  add('Secrets required', '+', 'secret', policy.secrets?.require);

  // Docker describes itself: what a container grant means is the docker
  // grammar's business, and the line it produces is already the flat form.
  for (const grant of describeDockerGrants(policy.docker, '')) {
    grants.push({ group: 'Docker', marker: '+', value: grant, summary: `${prefix}${grant}` });
  }

  return grants;
}
