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
function summarizeGrants(config: {
  shared?: {
    network?: { allow?: string[] };
    filesystem?: { read?: string[]; write?: string[] };
    sockets?: { allow?: string[] };
  };
}): string[] {
  const grants: string[] = [];
  const shared = config.shared || {};

  for (const host of shared.network?.allow || []) {
    grants.push(`network: ${host}`);
  }
  for (const p of shared.filesystem?.read || []) {
    grants.push(`read: ${p}`);
  }
  for (const p of shared.filesystem?.write || []) {
    grants.push(`write: ${p}`);
  }
  for (const p of shared.sockets?.allow || []) {
    grants.push(`socket: ${p}`);
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
