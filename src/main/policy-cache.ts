/**
 * Policy Cache Manager
 *
 * Caches .localmostrc policies per repository for the background runner.
 * Detects changes and requires approval before running jobs with updated policies.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  LocalmostrcConfig,
  parseLocalmostrcContent,
  diffConfigs,
  PolicyDiff,
  formatPolicyDiff,
} from '../shared/localmostrc';
import { getAppDataDir } from './paths';
import { getLogger } from './app-state';

const log = {
  debug: (message: string) => getLogger()?.debug(message),
  info: (message: string) => getLogger()?.info(message),
  warn: (message: string) => getLogger()?.warn(message),
};

// =============================================================================
// Types
// =============================================================================

export interface CachedPolicy {
  /** Repository identifier (owner/repo) */
  repository: string;
  /** The cached policy config */
  config: LocalmostrcConfig;
  /** When the policy was cached */
  cachedAt: string;
  /** SHA of the commit when policy was approved */
  approvedAtCommit?: string;
  /** Whether the policy has been explicitly approved */
  approved: boolean;
}

export interface PolicyApprovalRequest {
  repository: string;
  oldConfig?: LocalmostrcConfig;
  newConfig: LocalmostrcConfig;
  diffs: PolicyDiff[];
  isNewRepo: boolean;
}

export type PolicyApprovalCallback = (request: PolicyApprovalRequest) => Promise<boolean>;

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
 * Ensure the cache directory exists.
 */
function ensureCacheDir(): void {
  const dir = getPolicyCacheDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Get the path for a cached policy file.
 */
function getPolicyFilePath(repository: string): string {
  const safeRepo = repository.replace('/', '_');
  return path.join(getPolicyCacheDir(), `${safeRepo}.json`);
}

/**
 * Load a cached policy for a repository.
 */
export function getCachedPolicy(repository: string): CachedPolicy | null {
  const filePath = getPolicyFilePath(repository);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as CachedPolicy;
  } catch (err) {
    log.warn(`Failed to load cached policy for ${repository}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Save a policy to the cache.
 */
export function cachePolicyConfig(
  repository: string,
  config: LocalmostrcConfig,
  approved: boolean = false,
  commit?: string
): void {
  ensureCacheDir();

  const cached: CachedPolicy = {
    repository,
    config,
    cachedAt: new Date().toISOString(),
    approvedAtCommit: commit,
    approved,
  };

  const filePath = getPolicyFilePath(repository);
  fs.writeFileSync(filePath, JSON.stringify(cached, null, 2));
  log.debug(`Cached policy for ${repository}`);
}

/**
 * Mark a cached policy as approved.
 */
export function approvePolicy(repository: string, commit?: string): void {
  const cached = getCachedPolicy(repository);
  if (cached) {
    cached.approved = true;
    cached.approvedAtCommit = commit;
    const filePath = getPolicyFilePath(repository);
    fs.writeFileSync(filePath, JSON.stringify(cached, null, 2));
    log.info(`Approved policy for ${repository}`);
  }
}

/**
 * Remove a cached policy.
 */
export function removeCachedPolicy(repository: string): boolean {
  const filePath = getPolicyFilePath(repository);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    log.debug(`Removed cached policy for ${repository}`);
    return true;
  }
  return false;
}

/**
 * List all cached policies.
 */
export function listCachedPolicies(): CachedPolicy[] {
  const dir = getPolicyCacheDir();
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const policies: CachedPolicy[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      policies.push(JSON.parse(content));
    } catch {
      // Skip invalid files
    }
  }

  return policies;
}

// =============================================================================
// Policy Validation for Jobs
// =============================================================================

/**
 * Validate a policy for a job.
 * Returns null if approved, or a PolicyApprovalRequest if approval is needed.
 */
export function validatePolicyForJob(
  repository: string,
  localmostrcContent: string | null
): PolicyApprovalRequest | null {
  const cached = getCachedPolicy(repository);

  // No .localmostrc in repo
  if (!localmostrcContent) {
    if (!cached) {
      // New repo without policy - needs approval to run with default policy
      return {
        repository,
        oldConfig: undefined,
        newConfig: { version: 1, shared: {} },
        diffs: [],
        isNewRepo: true,
      };
    }
    // Had a policy before, now removed - needs approval
    return {
      repository,
      oldConfig: cached.config,
      newConfig: { version: 1, shared: {} },
      diffs: diffConfigs(cached.config, { version: 1, shared: {} }),
      isNewRepo: false,
    };
  }

  // Parse the new policy
  const parseResult = parseLocalmostrcContent(localmostrcContent);
  if (!parseResult.success || !parseResult.config) {
    log.warn(`Invalid .localmostrc for ${repository}: ${parseResult.errors[0]?.message}`);
    // Invalid policy - treat as no policy
    return {
      repository,
      oldConfig: cached?.config,
      newConfig: { version: 1, shared: {} },
      diffs: [],
      isNewRepo: !cached,
    };
  }

  const newConfig = parseResult.config;

  // No cached policy - new repo
  if (!cached) {
    return {
      repository,
      oldConfig: undefined,
      newConfig,
      diffs: [],
      isNewRepo: true,
    };
  }

  // Compare with cached
  const diffs = diffConfigs(cached.config, newConfig);

  // No changes and previously approved
  if (diffs.length === 0 && cached.approved) {
    return null;
  }

  // Changes detected
  if (diffs.length > 0) {
    return {
      repository,
      oldConfig: cached.config,
      newConfig,
      diffs,
      isNewRepo: false,
    };
  }

  // No changes but not yet approved
  if (!cached.approved) {
    return {
      repository,
      oldConfig: cached.config,
      newConfig,
      diffs: [],
      isNewRepo: false,
    };
  }

  return null;
}

/**
 * Append an approval decision to an audit log.
 *
 * Approving a policy widens what someone else's code may do on this machine,
 * so the decision is worth a durable record separate from the cache entry,
 * which only ever holds the current state.
 */
export function recordPolicyDecision(repository: string, decision: 'approved' | 'rejected'): void {
  try {
    ensureCacheDir();
    const line = JSON.stringify({ at: new Date().toISOString(), repository, decision });
    fs.appendFileSync(path.join(getPolicyCacheDir(), 'decisions.log'), `${line}\n`);
  } catch (err) {
    log.warn(`Could not record policy decision for ${repository}: ${(err as Error).message}`);
  }
}

/**
 * What should happen to a job, given the repository's current .localmostrc.
 */
export type PolicyDecision =
  | { action: 'allow'; reason: 'no-policy' | 'unchanged' | 'narrowed' }
  | { action: 'needs-approval'; request: PolicyApprovalRequest };

/**
 * Decide whether a job may run under the repository's current policy.
 *
 * A .localmostrc grants access beyond the built-in baseline, so its arrival or
 * change is a request for more privilege and needs the machine owner's consent.
 * A repository with no policy is not asked about: it gets the baseline, which
 * grants nothing extra. Removing a policy is likewise allowed without asking -
 * it can only reduce access.
 */
export function decidePolicyForJob(
  repository: string,
  localmostrcContent: string | null
): PolicyDecision {
  const cached = getCachedPolicy(repository);

  if (!localmostrcContent) {
    return { action: 'allow', reason: cached ? 'narrowed' : 'no-policy' };
  }

  const parseResult = parseLocalmostrcContent(localmostrcContent);
  if (!parseResult.success || !parseResult.config) {
    // An unreadable policy grants nothing; the job runs on the baseline.
    log.warn(`Invalid .localmostrc for ${repository}: ${parseResult.errors[0]?.message}`);
    return { action: 'allow', reason: 'no-policy' };
  }

  const newConfig = parseResult.config;

  if (cached?.approved) {
    const diffs = diffConfigs(cached.config, newConfig);
    if (diffs.length === 0) {
      return { action: 'allow', reason: 'unchanged' };
    }
    return {
      action: 'needs-approval',
      request: { repository, oldConfig: cached.config, newConfig, diffs, isNewRepo: false },
    };
  }

  return {
    action: 'needs-approval',
    request: {
      repository,
      oldConfig: cached?.config,
      newConfig,
      diffs: cached ? diffConfigs(cached.config, newConfig) : [],
      isNewRepo: !cached,
    },
  };
}

/**
 * Record a policy as awaiting approval, so the CLI can show what is pending.
 */
export function recordPendingPolicy(repository: string, config: LocalmostrcConfig): void {
  cachePolicyConfig(repository, config, false);
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

// =============================================================================
// Event Emitter for Policy Changes
// =============================================================================

let approvalCallback: PolicyApprovalCallback | null = null;

/**
 * Register a callback for policy approval requests.
 */
export function onPolicyApprovalNeeded(callback: PolicyApprovalCallback): void {
  approvalCallback = callback;
}

/**
 * Request policy approval (calls registered callback).
 */
export async function requestPolicyApproval(request: PolicyApprovalRequest): Promise<boolean> {
  if (!approvalCallback) {
    log.warn('No policy approval callback registered');
    return false;
  }

  return approvalCallback(request);
}

/**
 * Check if a job can run based on policy.
 * If approval is needed, requests it and waits for response.
 */
export async function canRunJob(
  repository: string,
  localmostrcContent: string | null
): Promise<boolean> {
  const approvalRequest = validatePolicyForJob(repository, localmostrcContent);

  if (!approvalRequest) {
    // No approval needed - policy is cached and unchanged
    return true;
  }

  // Log what's happening
  log.info(formatApprovalRequest(approvalRequest));

  // Request approval
  const approved = await requestPolicyApproval(approvalRequest);

  if (approved) {
    // Cache the new policy as approved
    cachePolicyConfig(repository, approvalRequest.newConfig, true);
  }

  return approved;
}
