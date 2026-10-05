/**
 * Policy Cache Manager
 *
 * Caches .localmostrc policies per repository for the background runner.
 * Detects changes and requires approval before running jobs with updated policies.
 * The cache itself - its format, and how approval is bound to what was shown -
 * is shared with the CLI in shared/policy-store.
 */

import * as path from 'path';
import {
  LocalmostrcConfig,
  parseLocalmostrcContent,
  diffConfigs,
  PolicyDiff,
  formatPolicyDiff,
  getEffectivePolicy,
} from '../shared/localmostrc';
import { hasDockerGrants } from '../shared/docker-policy';
import {
  PolicyEntry,
  approvalStamp,
  approvePending,
  bindRepositoryId,
  isRepositoryId,
  listPolicyEntries,
  readPolicyEntry,
  recordPending,
  rejectPending,
  recordPolicyDecision as appendPolicyDecision,
} from '../shared/policy-store';
import { getAppDataDir } from './paths';
import { getLogger } from './app-state';

export { approvalStamp };
export type { PolicyEntry };

const log = {
  debug: (message: string) => getLogger()?.debug(message),
  info: (message: string) => getLogger()?.info(message),
  warn: (message: string) => getLogger()?.warn(message),
};

// =============================================================================
// Types
// =============================================================================

export interface PolicyApprovalRequest {
  repository: string;
  oldConfig?: LocalmostrcConfig;
  newConfig: LocalmostrcConfig;
  diffs: PolicyDiff[];
  isNewRepo: boolean;
  /**
   * The repository id the approved policy was bound to, when the job came
   * from a different repository under the same name.
   */
  replacesRepositoryId?: number;
}

// =============================================================================
// Cache Management
// =============================================================================

const POLICY_CACHE_DIR = 'policies';

/**
 * Get the policies cache directory.
 */
function getPolicyCacheDir(): string {
  return path.join(getAppDataDir(), POLICY_CACHE_DIR);
}

/**
 * Load a repository's cache entry. An entry that cannot be trusted reads as
 * none: its approved policy is not applied, and the next job asks again.
 */
export function getPolicyEntry(repository: string): PolicyEntry | null {
  try {
    return readPolicyEntry(getPolicyCacheDir(), repository);
  } catch (err) {
    log.warn(`Ignoring cached policy for ${repository}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * The policy approved for a repository, whatever commit a job is at. Not
 * exported: a job is given getApprovedPolicyForCommit, which also asks
 * whether the job's own commit carries this policy.
 */
function getApprovedPolicy(repository: string): LocalmostrcConfig | null {
  return getPolicyEntry(repository)?.approved?.config ?? null;
}

/**
 * Approve the pending policy for a repository, provided the stamp the reviewer
 * quotes is the one it was shown with. Throws otherwise.
 */
export function approvePolicy(repository: string, stamp: string): void {
  approvePending(getPolicyCacheDir(), repository, stamp);
  recordPolicyDecision(repository, 'approved', stamp);
  log.info(`Approved policy for ${repository} (${stamp.slice(0, 12)})`);
}

/**
 * Drop the pending policy for a repository. The approved one stays in force.
 */
export function rejectPolicy(repository: string): void {
  const stamp = rejectPending(getPolicyCacheDir(), repository);
  // A decision about nothing would be noise in the audit log.
  if (!stamp) throw new Error(`There is nothing waiting for approval for ${repository}`);
  recordPolicyDecision(repository, 'rejected', stamp);
  log.info(`Rejected pending policy for ${repository}`);
}

/**
 * List all cached policies.
 */
export function listCachedPolicies(): PolicyEntry[] {
  return listPolicyEntries(getPolicyCacheDir());
}

// =============================================================================
// Policy Validation for Jobs
// =============================================================================

/**
 * Append an approval decision to the audit log, with the stamp of the policy
 * decided on, so the record says which policy it was and not just when.
 */
export function recordPolicyDecision(
  repository: string,
  decision: 'approved' | 'rejected',
  stamp?: string
): void {
  try {
    appendPolicyDecision(getPolicyCacheDir(), { repository, decision, stamp, via: 'app' });
  } catch (err) {
    log.warn(`Could not record policy decision for ${repository}: ${(err as Error).message}`);
  }
}

/**
 * What should happen to a job, given the repository's current .localmostrc.
 */
export type PolicyDecision =
  | { action: 'allow'; reason: 'no-policy' | 'unchanged' | 'narrowed' }
  | { action: 'needs-approval'; request: PolicyApprovalRequest }
  | { action: 'invalid'; reason: string };

/**
 * The checked commits the approved policy covers, keyed by repository and
 * commit, each with the stamp of the approved policy its .localmostrc matched.
 *
 * The approval cache is per repository, but a job runs one commit, and a
 * commit whose file was deleted must not inherit the grants of one that had
 * it. So the approved policy goes only to a commit the pre-spawn check found
 * carrying it. A commit it never saw, or saw under another name (the check
 * keys on the name GitHub reports, the policy lookup on the target's), gets
 * nothing, and neither does one whose approved policy has been replaced
 * since: that is no longer the commit's own file. Every legitimate job is
 * checked in this process, at the same commit, before its worker is spawned,
 * so none loses its grants to this; an entry that is evicted or lost on
 * restart fails to the baseline.
 */
const commitCoverage = new Map<string, string>();
const COMMIT_COVERAGE_LIMIT = 1000;

function commitKey(repository: string, sha: string): string {
  return `${repository.toLowerCase()}@${sha}`;
}

function recordCommitCoverage(repository: string, sha: string, coveredBy: LocalmostrcConfig | null): void {
  const key = commitKey(repository, sha);
  commitCoverage.delete(key);
  if (!coveredBy) return;
  commitCoverage.set(key, approvalStamp(repository, coveredBy));
  if (commitCoverage.size > COMMIT_COVERAGE_LIMIT) {
    commitCoverage.delete(commitCoverage.keys().next().value as string);
  }
}

/**
 * The approved policy to apply to a job at a given commit: only one the
 * pre-spawn check found that commit's .localmostrc matching, and only while it
 * is still the approved policy. Anything else runs on the baseline.
 */
export function getApprovedPolicyForCommit(repository: string, sha: string): LocalmostrcConfig | null {
  const coveredBy = commitCoverage.get(commitKey(repository, sha));
  if (!coveredBy) return null;
  const approved = getApprovedPolicy(repository);
  return approved && approvalStamp(repository, approved) === coveredBy ? approved : null;
}

/**
 * Whether the approved policy for a job's commit grants Docker to the job's
 * workflow - shared and its own section merged, as the claim binds it - as
 * admission asks before spawning. A job with no commit, or at one the check
 * did not find carrying the approved policy, gets the baseline: no Docker.
 */
export function approvedDockerForCommit(
  repository: string,
  sha: string | undefined,
  workflow: string | undefined
): boolean {
  const approved = sha ? getApprovedPolicyForCommit(repository, sha) : null;
  return approved !== null && hasDockerGrants(getEffectivePolicy(approved, workflow ?? '').docker);
}

/**
 * Decide whether a job may run under the repository's current policy.
 *
 * A .localmostrc grants access beyond the built-in baseline, so its arrival or
 * change is a request for more privilege and needs the machine owner's consent.
 * A repository with no policy is not asked about: it gets the baseline, which
 * grants nothing extra. Removing a policy is likewise allowed without asking,
 * because the job then runs on the baseline: only a commit decided here as
 * carrying the approved policy is given it by getApprovedPolicyForCommit.
 * The commit is required so that a caller cannot decide without recording.
 *
 * The repository id, when the job carries one, is held to the one the
 * approval was bound to: a name can be freed by deleting or renaming a
 * repository and taken by another, whose .localmostrc need only match the
 * approved one to inherit its grants. An approval bound to no id yet is
 * bound to the first job that matches it.
 */
export function decidePolicyForJob(
  repository: string,
  localmostrcContent: string | null,
  sha: string,
  jobRepositoryId?: number
): PolicyDecision {
  const repositoryId = validRepositoryId(repository, jobRepositoryId);
  const decision = decide(repository, localmostrcContent, repositoryId);
  const covered = decision.action === 'allow' && decision.reason === 'unchanged';
  if (covered && repositoryId !== undefined) {
    try {
      bindRepositoryId(getPolicyCacheDir(), repository, repositoryId);
    } catch (err) {
      log.warn(`Could not bind the approved policy for ${repository} to its repository id: ${(err as Error).message}`);
    }
  }
  recordCommitCoverage(repository, sha, covered ? getApprovedPolicy(repository) : null);
  return decision;
}

/**
 * The job's repository id, or undefined when it carries none or one that is
 * not an id. A malformed one is treated as none, as before ids were kept,
 * rather than compared or stored: stored, it made the entry unreadable, and
 * the next change replaced the entry, approval and all.
 */
function validRepositoryId(repository: string, repositoryId: number | undefined): number | undefined {
  if (repositoryId === undefined || isRepositoryId(repositoryId)) return repositoryId;
  log.warn(`Ignoring a malformed repository id for ${repository}: ${String(repositoryId)}`);
  return undefined;
}

function decide(repository: string, localmostrcContent: string | null, repositoryId?: number): PolicyDecision {
  const approvedVersion = getPolicyEntry(repository)?.approved;
  const approved = approvedVersion?.config ?? null;

  if (!localmostrcContent) {
    return { action: 'allow', reason: approved ? 'narrowed' : 'no-policy' };
  }

  const parseResult = parseLocalmostrcContent(localmostrcContent);
  if (!parseResult.success || !parseResult.config) {
    // The repository has a policy; we just cannot read it. Running anyway would
    // mean deciding on a file nobody has reviewed, so hold the job instead.
    const detail = parseResult.errors[0]?.message ?? 'unknown error';
    log.warn(`Invalid .localmostrc for ${repository}: ${detail}`);
    return { action: 'invalid', reason: detail };
  }

  const newConfig = parseResult.config;

  if (approved) {
    const diffs = diffConfigs(approved, newConfig);
    const boundTo = approvedVersion?.repositoryId;
    if (repositoryId !== undefined && boundTo !== undefined && repositoryId !== boundTo) {
      // Another repository under the approved one's name: what was approved
      // was never asked for by this one.
      return {
        action: 'needs-approval',
        request: { repository, oldConfig: approved, newConfig, diffs, isNewRepo: true, replacesRepositoryId: boundTo },
      };
    }
    if (diffs.length === 0) {
      return { action: 'allow', reason: 'unchanged' };
    }
    return {
      action: 'needs-approval',
      request: { repository, oldConfig: approved, newConfig, diffs, isNewRepo: false },
    };
  }

  return {
    action: 'needs-approval',
    request: { repository, oldConfig: undefined, newConfig, diffs: [], isNewRepo: true },
  };
}

/**
 * Record a policy as awaiting approval, so the app and the CLI can show what
 * is pending. An approved policy is left in force alongside it.
 */
export function recordPendingPolicy(repository: string, config: LocalmostrcConfig, repositoryId?: number): void {
  recordPending(getPolicyCacheDir(), repository, config, validRepositoryId(repository, repositoryId));
  log.debug(`Recorded pending policy for ${repository}`);
}

/**
 * Format a policy approval request for notification.
 */
export function formatApprovalRequest(request: PolicyApprovalRequest): string {
  const lines: string[] = [];

  if (request.replacesRepositoryId !== undefined) {
    lines.push(`New repository under an approved name: ${request.repository}`);
    lines.push('');
    lines.push(`Its policy was approved for repository id ${request.replacesRepositoryId}, and this job`);
    lines.push('comes from a different repository with that name. Review the sandbox policy before approving.');
  } else if (request.isNewRepo) {
    lines.push(`New repository: ${request.repository}`);
    lines.push('');
    lines.push('This repository wants to run workflows on your machine.');
    lines.push('Review the sandbox policy before approving.');
  } else if (request.diffs.length > 0) {
    lines.push(`Policy change detected: ${request.repository}`);
    lines.push('');
    lines.push(formatPolicyDiff(request.diffs));
  } else {
    lines.push(`Approval required: ${request.repository}`);
    lines.push('');
    lines.push('This repository\'s policy has not been approved yet.');
  }

  return lines.join('\n');
}
