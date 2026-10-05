/**
 * What a repository's approved policy means for one job at runtime.
 *
 * The approved copy only, never the repository's current file: a job reaches
 * this once its policy has been approved, and applying the approved copy means
 * an unreviewed change cannot take effect through a race.
 */

import { createHash } from 'crypto';
import { getEffectivePolicy, effectivePolicyLevel, LocalmostrcConfig, SharedPolicy } from '../shared/localmostrc';
import { spawnEnvPolicy } from './worker-env';
import type { RepoPolicyRuntime } from './runner-manager';

/**
 * The identity of an approved policy, as a worker started under it is
 * compared with the one in force when it claims its job: its network (the
 * level and every section's hosts), Docker, the filesystem grants a VM will
 * be given and the environment a worker gets. Taken over every section,
 * each workflow's included, so it does not depend on which workflow a job
 * turns out to be: the spawn's stamp, taken before the workflow is known,
 * differs from the claim's only when the approved policy itself changed.
 * Secrets are left out: they grant nothing a worker holds.
 */
export function policyStamp(approved: LocalmostrcConfig | null): string {
  const section = (policy: SharedPolicy | undefined) => ({
    network: { allow: policy?.network?.allow ?? [], deny: policy?.network?.deny ?? [] },
    docker: policy?.docker ?? {},
    filesystem: {
      read: policy?.filesystem?.read ?? [],
      write: policy?.filesystem?.write ?? [],
      deny: policy?.filesystem?.deny ?? [],
    },
  });
  const workflows = Object.keys(approved?.workflows ?? {})
    .sort()
    .map((name) => [name, section(approved?.workflows?.[name])]);
  const identity = {
    level: effectivePolicyLevel(approved),
    shared: section(approved?.shared),
    workflows,
    env: approved ? spawnEnvPolicy(approved) : { allow: [], deny: [] },
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/**
 * The runtime policy for a job of `workflowName` under `approved`, or the
 * baseline - strict, nothing granted - when there is no approved policy for
 * the job's commit.
 */
export function repoPolicyRuntime(approved: LocalmostrcConfig | null, workflowName: string): RepoPolicyRuntime {
  const stamp = policyStamp(approved);
  if (!approved) {
    return {
      hosts: [],
      deniedHosts: [],
      level: 'strict' as const,
      readPaths: [],
      writePaths: [],
      denyPaths: [],
      docker: {},
      stamp,
    };
  }
  const policy = getEffectivePolicy(approved, workflowName);
  const loopback = approved.shared?.network?.loopback;
  return {
    // Network is resolved per workflow and applied to the proxy per job.
    hosts: policy.network?.allow || [],
    // Denied hosts the same way: shared and the workflow's, merged.
    deniedHosts: policy.network?.deny || [],
    level: effectivePolicyLevel(approved),
    // Filesystem comes from the shared section only: what a worker is given
    // is fixed when it starts, before the workflow is known. A macOS VM job
    // is given none of it yet; the runner names what it leaves out.
    readPaths: approved.shared?.filesystem?.read || [],
    writePaths: approved.shared?.filesystem?.write || [],
    denyPaths: approved.shared?.filesystem?.deny || [],
    // Declared, and named in the log as not given: a VM job reaches only its
    // proxy and the broker. An empty list declares nothing.
    ...(loopback === true || (Array.isArray(loopback) && loopback.length > 0) ? { loopback } : {}),
    // Docker composes across shared and workflow: the socket is bound to
    // the merged policy when the job is claimed, after the workflow is known.
    docker: policy.docker ?? {},
    // Fixed at spawn: see spawnEnvPolicy.
    env: spawnEnvPolicy(approved),
    stamp,
  };
}
