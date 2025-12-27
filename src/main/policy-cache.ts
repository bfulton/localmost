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
import { log } from './logging';

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
const POLICY_INDEX_FILE = 'policy-index.json';

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
