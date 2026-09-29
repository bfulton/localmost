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
} from '../shared/localmostrc';
import {
  PolicyEntry,
  approvalStamp,
  approvePending,
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
 * The policy a repository's jobs run under, if one has been approved.
 */
export function getApprovedPolicy(repository: string): LocalmostrcConfig | null {
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
 * Which checked commits the approved policy covers, keyed by repository and
 * commit: true when the commit's .localmostrc is the approved policy, false
 * when it has none or a different one.
 *
 * The approval cache is per repository, but a job runs one commit, and a
 * commit whose file was deleted must not inherit the grants of one that had
 * it. A commit's content never changes, so an answer never goes stale; the
 * map is bounded only because nothing else would ever empty it.
 */
const commitCoverage = new Map<string, boolean>();
const COMMIT_COVERAGE_LIMIT = 1000;

function commitKey(repository: string, sha: string): string {
  return `${repository.toLowerCase()}@${sha}`;
}

function recordCommitCoverage(repository: string, sha: string, covered: boolean): void {
  const key = commitKey(repository, sha);
  commitCoverage.delete(key);
  commitCoverage.set(key, covered);
  if (commitCoverage.size > COMMIT_COVERAGE_LIMIT) {
    commitCoverage.delete(commitCoverage.keys().next().value as string);
  }
}

/**
 * The approved policy to apply to a job at a given commit.
 *
 * Null for a commit the pre-spawn check found without the approved policy:
 * no .localmostrc, so the baseline, or one that was refused. A commit it never
 * checked gets the repository's approved policy, as before this existed.
 */
export function getApprovedPolicyForCommit(repository: string, sha: string): LocalmostrcConfig | null {
  if (commitCoverage.get(commitKey(repository, sha)) === false) return null;
  return getApprovedPolicy(repository);
}

/**
 * Decide whether a job may run under the repository's current policy.
 *
 * A .localmostrc grants access beyond the built-in baseline, so its arrival or
 * change is a request for more privilege and needs the machine owner's consent.
 * A repository with no policy is not asked about: it gets the baseline, which
 * grants nothing extra. Removing a policy is likewise allowed without asking,
 * because the job then runs on the baseline: with the commit given, the
 * decision is remembered, and getApprovedPolicyForCommit applies nothing to it.
 */
export function decidePolicyForJob(
  repository: string,
  localmostrcContent: string | null,
  sha?: string
): PolicyDecision {
  const decision = decide(repository, localmostrcContent);
  if (sha) {
    recordCommitCoverage(repository, sha, decision.action === 'allow' && decision.reason === 'unchanged');
  }
  return decision;
}

function decide(repository: string, localmostrcContent: string | null): PolicyDecision {
  const approved = getApprovedPolicy(repository);

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
export function recordPendingPolicy(repository: string, config: LocalmostrcConfig): void {
  recordPending(getPolicyCacheDir(), repository, config);
  log.debug(`Recorded pending policy for ${repository}`);
}

/**
 * Format a policy approval request for notification.
 */
export function formatApprovalRequest(request: PolicyApprovalRequest): string {
  const lines: string[] = [];

  if (request.isNewRepo) {
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
