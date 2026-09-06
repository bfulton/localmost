/**
 * IPC handlers for reviewing and approving repository sandbox policies.
 *
 * A repository's .localmostrc grants sandbox access beyond the built-in
 * baseline, so the runner holds any job whose policy is new or changed until
 * the machine's owner approves it. These handlers are how that approval
 * happens without leaving the app.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS, PolicySummary, Result } from '../../shared/types';
import {
  listCachedPolicies,
  approvePolicy,
  removeCachedPolicy,
  recordPolicyDecision,
} from '../policy-cache';
import {
  getRunnerManager, getLogger } from '../app-state';
import { DockerPolicy } from '../../shared/docker-policy';

/**
 * Describe what a policy grants, in the terms a reviewer cares about.
 */
interface PolicySection {
  network?: { allow?: string[] };
  filesystem?: { read?: string[]; write?: string[] };
  sockets?: { allow?: string[] };
  docker?: DockerPolicy;
}

/**
 * What a docker policy grants, in the reviewer's terms.
 *
 * Every action block is named even when it carries no conditions: `run: {}` is
 * a real grant - it permits creating and running containers - and an approval
 * screen that showed nothing for it would be asking consent for an invisible
 * capability.
 */
function describeDocker(docker: DockerPolicy | undefined, prefix: string): string[] {
  if (!docker) return [];
  const grants: string[] = [];
  if (docker.pull) {
    const registries = docker.pull.registries ?? [];
    if (registries.length === 0) grants.push(`${prefix}docker pull`);
    for (const registry of registries) grants.push(`${prefix}docker pull: ${registry}`);
  }
  if (docker.run) {
    const { images = [], mounts = [], network } = docker.run;
    if (images.length === 0 && mounts.length === 0 && network === undefined) {
      grants.push(`${prefix}docker run`);
    }
    for (const image of images) grants.push(`${prefix}docker run image: ${image}`);
    for (const mount of mounts) grants.push(`${prefix}docker mount: ${mount.path} (${mount.mode})`);
    if (network !== undefined) grants.push(`${prefix}docker network: ${network}`);
  }
  if (docker.build) {
    grants.push(docker.build.context === undefined
      ? `${prefix}docker build`
      : `${prefix}docker build: ${docker.build.context}`);
  }
  if (docker.privileged) grants.push(`${prefix}docker privileged`);
  return grants;
}

function describeSection(section: PolicySection, prefix: string): string[] {
  const grants: string[] = [];
  for (const host of section.network?.allow || []) {
    grants.push(`${prefix}network: ${host}`);
  }
  for (const p of section.filesystem?.read || []) {
    grants.push(`${prefix}read: ${p}`);
  }
  for (const p of section.filesystem?.write || []) {
    grants.push(`${prefix}write: ${p}`);
  }
  for (const p of section.sockets?.allow || []) {
    grants.push(`${prefix}socket: ${p}`);
  }
  grants.push(...describeDocker(section.docker, prefix));
  return grants;
}

/**
 * Describe everything a policy grants, in the terms a reviewer cares about.
 *
 * Per-workflow sections are included: a policy can grant access under
 * `workflows:` that appears nowhere in `shared`, and approving what the UI
 * showed would otherwise approve more than was shown.
 */
export function summarizeGrants(config: {
  shared?: PolicySection;
  workflows?: Record<string, PolicySection>;
}): string[] {
  const grants = describeSection(config.shared || {}, '');
  for (const [workflow, section] of Object.entries(config.workflows || {})) {
    grants.push(...describeSection(section || {}, `${workflow}: `));
  }
  return grants;
}

export const registerPolicyHandlers = (): void => {
  const log = () => getLogger();

  ipcMain.handle(IPC_CHANNELS.POLICY_LIST, (): PolicySummary[] => {
    return listCachedPolicies().map(entry => ({
      repository: entry.repository,
      approved: entry.approved,
      cachedAt: entry.cachedAt,
      grants: summarizeGrants(entry.config),
    }));
  });

  ipcMain.handle(IPC_CHANNELS.POLICY_APPROVE, async (_event, repository: string): Promise<Result> => {
    try {
      approvePolicy(repository);
      recordPolicyDecision(repository, 'approved');
      // Workers already running carry a sandbox profile built from the policy
      // that was approved before this one; retire them so the next job for
      // this repository runs under what was just approved.
      await getRunnerManager()?.retireWorkersForRepository(repository);
      log()?.info(`[Policy] Approved policy for ${repository}`);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.POLICY_REJECT, (_event, repository: string): Result => {
    try {
      removeCachedPolicy(repository);
      recordPolicyDecision(repository, 'rejected');
      log()?.info(`[Policy] Rejected policy for ${repository}`);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
};
