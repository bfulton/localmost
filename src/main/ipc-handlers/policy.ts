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
  rejectPolicy,
  approvalStamp,
} from '../policy-cache';
import { getRunnerManager, getLogger } from '../app-state';
import { DescribablePolicy, describePolicy } from '../../shared/policy-describe';
import { LocalmostrcConfig, diffConfigs, formatPolicyDiff } from '../../shared/localmostrc';
import { isValidRepository } from '../../shared/policy-store';

function describeSection(section: DescribablePolicy, prefix: string): string[] {
  return describePolicy(section, prefix).map((grant) => grant.summary);
}

/**
 * Describe everything a policy grants, in the terms a reviewer cares about.
 *
 * Per-workflow sections are included: a policy can grant access under
 * `workflows:` that appears nowhere in `shared`, and approving what the UI
 * showed would otherwise approve more than was shown.
 */
export function summarizeGrants(
  config: Pick<LocalmostrcConfig, 'level' | 'shared' | 'workflows'>
): string[] {
  // The level is declared once, at the top, and leads the list: it widens
  // every section below it.
  const grants = describeSection({ ...config.shared, level: config.level }, '');
  for (const [workflow, section] of Object.entries(config.workflows || {})) {
    grants.push(...describeSection(section || {}, `${workflow}: `));
  }
  return grants;
}

/**
 * What the approval screen shows: each repository's pending policy, if any,
 * and its approved one. A pending policy that would replace an approved one
 * carries what it changes, the level included, since that is what the
 * reviewer is being asked to agree to.
 */
export function listPolicySummaries(): PolicySummary[] {
  const summaries: PolicySummary[] = [];
  for (const entry of listCachedPolicies()) {
    if (entry.pending) {
      const summary: PolicySummary = {
        repository: entry.repository,
        approved: false,
        cachedAt: entry.pending.at,
        grants: summarizeGrants(entry.pending.config),
        stamp: approvalStamp(entry.repository, entry.pending.config),
      };
      if (entry.approved) {
        const diffs = diffConfigs(entry.approved.config, entry.pending.config);
        summary.changes = diffs.length > 0 ? formatPolicyDiff(diffs).split('\n') : [];
      }
      summaries.push(summary);
    }
    if (entry.approved) {
      summaries.push({
        repository: entry.repository,
        approved: true,
        cachedAt: entry.approved.at,
        grants: summarizeGrants(entry.approved.config),
        stamp: approvalStamp(entry.repository, entry.approved.config),
      });
    }
  }
  return summaries;
}

export const registerPolicyHandlers = (): void => {
  const log = () => getLogger();

  ipcMain.handle(IPC_CHANNELS.POLICY_LIST, (): PolicySummary[] => listPolicySummaries());

  ipcMain.handle(
    IPC_CHANNELS.POLICY_APPROVE,
    async (_event, repository: unknown, stamp: unknown): Promise<Result> => {
      try {
        if (!isValidRepository(repository)) {
          return { success: false, error: 'Not a repository name' };
        }
        if (typeof stamp !== 'string' || !/^[0-9a-f]{64}$/.test(stamp)) {
          return { success: false, error: `Approval for ${repository} did not say which policy it approves` };
        }
        // Refused unless the pending policy is still the one this stamp was
        // shown with: another refused job may have replaced it since.
        approvePolicy(repository, stamp);
        // Workers already running carry a sandbox profile built from the policy
        // that was approved before this one; retire them so the next job for
        // this repository runs under what was just approved.
        await getRunnerManager()?.retireWorkersForRepository(repository);
        log()?.info(`[Policy] Approved policy for ${repository}`);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.POLICY_REJECT, (_event, repository: unknown): Result => {
    try {
      if (!isValidRepository(repository)) {
        return { success: false, error: 'Not a repository name' };
      }
      rejectPolicy(repository);
      log()?.info(`[Policy] Rejected policy for ${repository}`);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
};
