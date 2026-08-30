/**
 * .localmostrc Parser and Validator
 *
 * Handles parsing, validation, and merging of declarative sandbox policies.
 */

import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import { SandboxPolicy, NetworkPolicy, FilesystemPolicy, EnvPolicy } from './sandbox-profile';

// =============================================================================
// Types
// =============================================================================

export const LOCALMOSTRC_VERSION = 1;

export interface SecretsPolicy {
  /** Secrets that must be provided for this workflow */
  require?: string[];
}

export interface WorkflowPolicy extends SandboxPolicy {
  secrets?: SecretsPolicy;
}

export interface LocalmostrcConfig {
  /** Config file version */
  version: number;
  /** Shared policy applied to all workflows */
  shared?: SandboxPolicy;
  /** Per-workflow policy overrides */
  workflows?: Record<string, WorkflowPolicy>;
}

export interface ParseError {
  message: string;
  line?: number;
  column?: number;
}

export interface ParseResult {
  success: boolean;
  config?: LocalmostrcConfig;
  errors: ParseError[];
  warnings: string[];
}

// =============================================================================
// Parsing
// =============================================================================

const LOCALMOSTRC_FILENAMES = ['.localmostrc', '.localmostrc.yml', '.localmostrc.yaml'];

/**
 * Find the .localmostrc file in a repository.
 */
export function findLocalmostrc(repoRoot: string): string | null {
  for (const filename of LOCALMOSTRC_FILENAMES) {
    const filePath = path.join(repoRoot, filename);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

/**
 * Parse a .localmostrc file.
 */
export function parseLocalmostrc(filePath: string): ParseResult {
  if (!fs.existsSync(filePath)) {
    return {
      success: false,
      errors: [{ message: `File not found: ${filePath}` }],
      warnings: [],
    };
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      success: false,
      errors: [{ message: `Failed to read file: ${(err as Error).message}` }],
      warnings: [],
    };
  }

  return parseLocalmostrcContent(content);
}

/**
 * Parse .localmostrc content string.
 */
export function parseLocalmostrcContent(content: string): ParseResult {
  const errors: ParseError[] = [];
  const warnings: string[] = [];

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    const yamlError = err as yaml.YAMLException;
    return {
      success: false,
      errors: [
        {
          message: yamlError.message,
          line: yamlError.mark?.line,
          column: yamlError.mark?.column,
        },
      ],
      warnings: [],
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      success: false,
      errors: [{ message: 'Invalid .localmostrc: must be a YAML object' }],
      warnings: [],
    };
  }

  const config = parsed as Record<string, unknown>;

  // Validate version
  if (config.version === undefined) {
    warnings.push('Missing "version" field. Assuming version 1.');
  } else if (typeof config.version !== 'number') {
    errors.push({ message: '"version" must be a number' });
  } else if (config.version !== LOCALMOSTRC_VERSION) {
    errors.push({
      message: `Unsupported version: ${config.version}. This tool supports version ${LOCALMOSTRC_VERSION}.`,
    });
  }

  // Validate shared policy
  if (config.shared !== undefined) {
    validatePolicy(config.shared, 'shared', errors);
  }

  // Validate per-workflow policies
  if (config.workflows !== undefined) {
    if (typeof config.workflows !== 'object' || config.workflows === null) {
      errors.push({ message: '"workflows" must be an object' });
    } else {
      for (const [workflowName, policy] of Object.entries(config.workflows as Record<string, unknown>)) {
        validatePolicy(policy, `workflows.${workflowName}`, errors);
        validateSecretsPolicy(policy, `workflows.${workflowName}`, errors);
      }
    }
  }

  if (errors.length > 0) {
    return { success: false, errors, warnings };
  }

  // Build a properly typed config object
  const typedConfig: LocalmostrcConfig = {
    version: typeof config.version === 'number' ? config.version : LOCALMOSTRC_VERSION,
    shared: config.shared as SandboxPolicy | undefined,
    workflows: config.workflows as Record<string, WorkflowPolicy> | undefined,
  };

  return {
    success: true,
    config: typedConfig,
    errors: [],
    warnings,
  };
}

/**
 * Validate a sandbox policy object.
 */
function validatePolicy(policy: unknown, path: string, errors: ParseError[]): void {
  if (policy === null || policy === undefined) {
    return; // Empty policy is valid
  }

  if (typeof policy !== 'object') {
    errors.push({ message: `${path} must be an object` });
    return;
  }

  const p = policy as Record<string, unknown>;

  // Validate network policy
  if (p.network !== undefined) {
    validateNetworkPolicy(p.network, `${path}.network`, errors);
  }

  // Validate filesystem policy
  if (p.filesystem !== undefined) {
    validateFilesystemPolicy(p.filesystem, `${path}.filesystem`, errors);
  }

  // Validate env policy
  if (p.env !== undefined) {
    validateEnvPolicy(p.env, `${path}.env`, errors);
  }
}

function validateNetworkPolicy(policy: unknown, path: string, errors: ParseError[]): void {
  if (typeof policy !== 'object' || policy === null) {
    errors.push({ message: `${path} must be an object` });
    return;
  }

  const p = policy as Record<string, unknown>;

  if (p.allow !== undefined) {
    validateStringArray(p.allow, `${path}.allow`, errors);
  }
  if (p.deny !== undefined) {
    validateStringArray(p.deny, `${path}.deny`, errors);
  }
}

function validateFilesystemPolicy(policy: unknown, path: string, errors: ParseError[]): void {
  if (typeof policy !== 'object' || policy === null) {
    errors.push({ message: `${path} must be an object` });
    return;
  }

  const p = policy as Record<string, unknown>;

  if (p.read !== undefined) {
    validateStringArray(p.read, `${path}.read`, errors);
  }
  if (p.write !== undefined) {
    validateStringArray(p.write, `${path}.write`, errors);
  }
  if (p.deny !== undefined) {
    validateStringArray(p.deny, `${path}.deny`, errors);
  }
}

function validateEnvPolicy(policy: unknown, path: string, errors: ParseError[]): void {
  if (typeof policy !== 'object' || policy === null) {
    errors.push({ message: `${path} must be an object` });
    return;
  }

  const p = policy as Record<string, unknown>;

  if (p.allow !== undefined) {
    validateStringArray(p.allow, `${path}.allow`, errors);
  }
  if (p.deny !== undefined) {
    validateStringArray(p.deny, `${path}.deny`, errors);
  }
}

function validateSecretsPolicy(policy: unknown, path: string, errors: ParseError[]): void {
  if (typeof policy !== 'object' || policy === null) {
    return;
  }

  const p = policy as Record<string, unknown>;
  if (p.secrets === undefined) {
    return;
  }

  if (typeof p.secrets !== 'object' || p.secrets === null) {
    errors.push({ message: `${path}.secrets must be an object` });
    return;
  }

  const s = p.secrets as Record<string, unknown>;
  if (s.require !== undefined) {
    validateStringArray(s.require, `${path}.secrets.require`, errors);
  }
}

function validateStringArray(value: unknown, path: string, errors: ParseError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ message: `${path} must be an array` });
    return;
  }

  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') {
      errors.push({ message: `${path}[${i}] must be a string` });
    }
  }
}

// =============================================================================
// Policy Merging
// =============================================================================

/**
 * Merge two string arrays, deduplicating.
 */
function mergeArrays(base?: string[], override?: string[]): string[] | undefined {
  if (!base && !override) {
    return undefined;
  }
  const result = new Set<string>(base || []);
  for (const item of override || []) {
    result.add(item);
  }
  return Array.from(result);
}

/**
 * Merge network policies.
 */
function mergeNetworkPolicy(base?: NetworkPolicy, override?: NetworkPolicy): NetworkPolicy | undefined {
  if (!base && !override) {
    return undefined;
  }

  return {
    allow: mergeArrays(base?.allow, override?.allow),
    deny: mergeArrays(base?.deny, override?.deny),
  };
}

/**
 * Merge filesystem policies.
 */
function mergeFilesystemPolicy(
  base?: FilesystemPolicy,
  override?: FilesystemPolicy
): FilesystemPolicy | undefined {
  if (!base && !override) {
    return undefined;
  }

  return {
    read: mergeArrays(base?.read, override?.read),
    write: mergeArrays(base?.write, override?.write),
    deny: mergeArrays(base?.deny, override?.deny),
  };
}

/**
 * Merge env policies.
 */
function mergeEnvPolicy(base?: EnvPolicy, override?: EnvPolicy): EnvPolicy | undefined {
  if (!base && !override) {
    return undefined;
  }

  return {
    allow: mergeArrays(base?.allow, override?.allow),
    deny: mergeArrays(base?.deny, override?.deny),
  };
}

/**
 * Merge two sandbox policies.
 * Override takes precedence, arrays are merged.
 */
export function mergePolicies(base: SandboxPolicy, override: SandboxPolicy): SandboxPolicy {
  return {
    network: mergeNetworkPolicy(base.network, override.network),
    filesystem: mergeFilesystemPolicy(base.filesystem, override.filesystem),
    env: mergeEnvPolicy(base.env, override.env),
  };
}

/**
 * Get the effective policy for a specific workflow.
 * Merges shared policy with workflow-specific overrides.
 */
export function getEffectivePolicy(config: LocalmostrcConfig, workflowName: string): SandboxPolicy {
  const shared = config.shared || {};
  const workflowPolicy = config.workflows?.[workflowName] || {};

  return mergePolicies(shared, workflowPolicy);
}

/**
 * Get required secrets for a workflow.
 */
export function getRequiredSecrets(config: LocalmostrcConfig, workflowName: string): string[] {
  return config.workflows?.[workflowName]?.secrets?.require || [];
}

// =============================================================================
// Serialization
// =============================================================================

/**
 * Generate a .localmostrc file from a config object.
 */
export function serializeLocalmostrc(config: LocalmostrcConfig): string {
  const lines: string[] = [];

  lines.push(`version: ${config.version}`);
  lines.push('');

  if (config.shared) {
    lines.push('shared:');
    lines.push(...serializePolicy(config.shared, '  '));
  }

  if (config.workflows && Object.keys(config.workflows).length > 0) {
    lines.push('');
    lines.push('workflows:');

    for (const [name, policy] of Object.entries(config.workflows)) {
      lines.push(`  ${name}:`);
      lines.push(...serializePolicy(policy, '    '));

      if (policy.secrets?.require?.length) {
        lines.push('    secrets:');
        lines.push('      require:');
        for (const secret of policy.secrets.require) {
          lines.push(`        - ${secret}`);
        }
      }
    }
  }

  return lines.join('\n') + '\n';
}

function serializePolicy(policy: SandboxPolicy, indent: string): string[] {
  const lines: string[] = [];

  if (policy.network) {
    lines.push(`${indent}network:`);
    if (policy.network.allow?.length) {
      lines.push(`${indent}  allow:`);
      for (const domain of policy.network.allow) {
        lines.push(`${indent}    - "${domain}"`);
      }
    }
    if (policy.network.deny?.length) {
      lines.push(`${indent}  deny:`);
      for (const domain of policy.network.deny) {
        lines.push(`${indent}    - "${domain}"`);
      }
    }
  }

  if (policy.filesystem) {
    lines.push(`${indent}filesystem:`);
    if (policy.filesystem.read?.length) {
      lines.push(`${indent}  read:`);
      for (const path of policy.filesystem.read) {
        lines.push(`${indent}    - "${path}"`);
      }
    }
    if (policy.filesystem.write?.length) {
      lines.push(`${indent}  write:`);
      for (const path of policy.filesystem.write) {
        lines.push(`${indent}    - "${path}"`);
      }
    }
    if (policy.filesystem.deny?.length) {
      lines.push(`${indent}  deny:`);
      for (const path of policy.filesystem.deny) {
        lines.push(`${indent}    - "${path}"`);
      }
    }
  }

  if (policy.env) {
    lines.push(`${indent}env:`);
    if (policy.env.allow?.length) {
      lines.push(`${indent}  allow:`);
      for (const name of policy.env.allow) {
        lines.push(`${indent}    - ${name}`);
      }
    }
    if (policy.env.deny?.length) {
      lines.push(`${indent}  deny:`);
      for (const name of policy.env.deny) {
        lines.push(`${indent}    - ${name}`);
      }
    }
  }

  return lines;
}

// =============================================================================
// Diffing
// =============================================================================

export interface PolicyDiff {
  path: string;
  type: 'added' | 'removed' | 'changed';
  oldValue?: string;
  newValue?: string;
}

/**
 * Compute diff between two configs.
 */
export function diffConfigs(oldConfig: LocalmostrcConfig, newConfig: LocalmostrcConfig): PolicyDiff[] {
  const diffs: PolicyDiff[] = [];

  // Compare shared policies
  diffPolicies(oldConfig.shared || {}, newConfig.shared || {}, 'shared', diffs);

  // Compare workflow policies
  const allWorkflows = new Set([
    ...Object.keys(oldConfig.workflows || {}),
    ...Object.keys(newConfig.workflows || {}),
  ]);

  for (const workflow of allWorkflows) {
    const oldPolicy = oldConfig.workflows?.[workflow] || {};
    const newPolicy = newConfig.workflows?.[workflow] || {};
    diffPolicies(oldPolicy, newPolicy, `workflows.${workflow}`, diffs);
  }

  return diffs;
}

function diffPolicies(
  oldPolicy: SandboxPolicy,
  newPolicy: SandboxPolicy,
  prefix: string,
  diffs: PolicyDiff[]
): void {
  // Network
  diffArrays(oldPolicy.network?.allow, newPolicy.network?.allow, `${prefix}.network.allow`, diffs);
  diffArrays(oldPolicy.network?.deny, newPolicy.network?.deny, `${prefix}.network.deny`, diffs);

  // Filesystem
  diffArrays(oldPolicy.filesystem?.read, newPolicy.filesystem?.read, `${prefix}.filesystem.read`, diffs);
  diffArrays(oldPolicy.filesystem?.write, newPolicy.filesystem?.write, `${prefix}.filesystem.write`, diffs);
  diffArrays(oldPolicy.filesystem?.deny, newPolicy.filesystem?.deny, `${prefix}.filesystem.deny`, diffs);

  // Env
  diffArrays(oldPolicy.env?.allow, newPolicy.env?.allow, `${prefix}.env.allow`, diffs);
  diffArrays(oldPolicy.env?.deny, newPolicy.env?.deny, `${prefix}.env.deny`, diffs);
}

function diffArrays(
  oldArr: string[] | undefined,
  newArr: string[] | undefined,
  path: string,
  diffs: PolicyDiff[]
): void {
  const oldSet = new Set(oldArr || []);
  const newSet = new Set(newArr || []);

  for (const item of newSet) {
    if (!oldSet.has(item)) {
      diffs.push({ path, type: 'added', newValue: item });
    }
  }

  for (const item of oldSet) {
    if (!newSet.has(item)) {
      diffs.push({ path, type: 'removed', oldValue: item });
    }
  }
}

/**
 * Format policy diff for display.
 */
export function formatPolicyDiff(diffs: PolicyDiff[]): string {
  if (diffs.length === 0) {
    return 'No changes';
  }

  const lines: string[] = [];
  for (const diff of diffs) {
    switch (diff.type) {
      case 'added':
        lines.push(`+ ${diff.path}: ${diff.newValue}`);
        break;
      case 'removed':
        lines.push(`- ${diff.path}: ${diff.oldValue}`);
        break;
      case 'changed':
        lines.push(`~ ${diff.path}: ${diff.oldValue} -> ${diff.newValue}`);
        break;
    }
  }
  return lines.join('\n');
}
