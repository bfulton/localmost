/**
 * What a repository's approved policy means for one job at runtime.
 *
 * The approved copy only, never the repository's current file: a job reaches
 * this once its policy has been approved, and applying the approved copy means
 * an unreviewed change cannot take effect through a race.
 */

import { getEffectivePolicy, effectivePolicyLevel, LocalmostrcConfig } from '../shared/localmostrc';
import { spawnEnvPolicy } from './worker-env';
import type { RepoPolicyRuntime } from './runner-manager';

/**
 * The runtime policy for a job of `workflowName` under `approved`, or the
 * baseline - strict, nothing granted - when there is no approved policy for
 * the job's commit.
 */
export function repoPolicyRuntime(approved: LocalmostrcConfig | null, workflowName: string): RepoPolicyRuntime {
  if (!approved) {
    return {
      hosts: [],
      deniedHosts: [],
      level: 'strict' as const,
      readPaths: [],
      writePaths: [],
      denyPaths: [],
      docker: {},
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
    // Filesystem comes from the shared section only. The sandbox profile
    // is built before the workflow is known and cannot change afterwards,
    // so a per-workflow filesystem section could not be applied - and
    // resolving it here would differ between spawn and claim and read as
    // policy drift.
    readPaths: approved.shared?.filesystem?.read || [],
    writePaths: approved.shared?.filesystem?.write || [],
    denyPaths: approved.shared?.filesystem?.deny || [],
    // Loopback is part of the profile too, and only shared: may declare it.
    // An empty list opens nothing, so it is no declaration, as an empty list
    // is none above; kept, it would change the spawn stamp and retire workers
    // for a policy that grants the same.
    ...(loopback === true || (Array.isArray(loopback) && loopback.length > 0) ? { loopback } : {}),
    // Docker composes across shared and workflow: the socket is bound to
    // the merged policy when the job is claimed, after the workflow is known.
    docker: policy.docker ?? {},
    // Fixed at spawn like the filesystem: see spawnEnvPolicy.
    env: spawnEnvPolicy(approved),
  };
}
