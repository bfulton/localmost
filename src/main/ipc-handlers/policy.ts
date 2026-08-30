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
import { getLogger } from '../app-state';

/**
 * Describe what a policy grants, in the terms a reviewer cares about.
 */
interface PolicySection {
  network?: { allow?: string[] };
  filesystem?: { read?: string[]; write?: string[] };
  sockets?: { allow?: string[] };
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
  return grants;
}

/**
 * Describe everything a policy grants, in the terms a reviewer cares about.
 *
 * Per-workflow sections are included: a policy can grant access under
 * `workflows:` that appears nowhere in `shared`, and approving what the UI
 * showed would otherwise approve more than was shown.
 */
function summarizeGrants(config: {
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

  ipcMain.handle(IPC_CHANNELS.POLICY_APPROVE, (_event, repository: string): Result => {
    try {
      approvePolicy(repository);
      recordPolicyDecision(repository, 'approved');
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
