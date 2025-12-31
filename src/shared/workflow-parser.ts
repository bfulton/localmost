/**
 * Workflow YAML Parser
 *
 * Parses GitHub Actions workflow files and provides typed access to jobs, steps,
 * and matrix configurations. Used by both the CLI test command and the app.
 */

import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Types
// =============================================================================

export interface WorkflowStep {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  shell?: string;
  with?: Record<string, string | number | boolean>;
  env?: Record<string, string>;
  if?: string;
  'working-directory'?: string;
  'continue-on-error'?: boolean;
  'timeout-minutes'?: number;
}

export interface MatrixConfig {
  [key: string]: (string | number | boolean)[];
}

export interface MatrixStrategy {
  matrix?: MatrixConfig;
  'fail-fast'?: boolean;
  'max-parallel'?: number;
}

export interface WorkflowJob {
  name?: string;
  /** Runner label(s) - required for regular jobs, absent for reusable workflow calls */
  'runs-on'?: string | string[];
  /** Reference to a reusable workflow (e.g., "./.github/workflows/check.yaml") */
  uses?: string;
  /** Inputs to pass to a reusable workflow */
  with?: Record<string, string | number | boolean>;
  /** Secrets to pass to a reusable workflow ('inherit' or explicit mapping) */
  secrets?: 'inherit' | Record<string, string>;
  needs?: string | string[];
  if?: string;
  strategy?: MatrixStrategy;
  env?: Record<string, string>;
  defaults?: {
    run?: {
      shell?: string;
      'working-directory'?: string;
    };
  };
  /** Steps to execute - required for regular jobs, absent for reusable workflow calls */
  steps?: WorkflowStep[];
  outputs?: Record<string, string>;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
  services?: Record<string, unknown>;
  container?: unknown;
}

export interface WorkflowTrigger {
  branches?: string[];
  paths?: string[];
  tags?: string[];
  types?: string[];
  schedule?: { cron: string }[];
}

/** Input definition for workflow_call trigger */
export interface WorkflowCallInput {
  description?: string;
  required?: boolean;
  type?: 'string' | 'boolean' | 'number';
  default?: string | boolean | number;
}

/** Output definition for workflow_call trigger */
export interface WorkflowCallOutput {
  description?: string;
  value: string;
}

/** workflow_call trigger configuration */
export interface WorkflowCallTrigger {
  inputs?: Record<string, WorkflowCallInput>;
  outputs?: Record<string, WorkflowCallOutput>;
  secrets?: Record<string, { description?: string; required?: boolean }>;
}

/** Parsed reusable workflow with its inputs/outputs */
export interface ReusableWorkflow extends ParsedWorkflow {
  /** Input definitions from workflow_call trigger */
  inputs: Record<string, WorkflowCallInput>;
  /** Output definitions from workflow_call trigger */
  outputs: Record<string, WorkflowCallOutput>;
}

export interface Workflow {
  name?: string;
  on: string | string[] | Record<string, WorkflowTrigger | WorkflowCallTrigger | null>;
  env?: Record<string, string>;
  defaults?: {
    run?: {
      shell?: string;
      'working-directory'?: string;
    };
  };
  jobs: Record<string, WorkflowJob>;
  permissions?: Record<string, string> | string;
}

export interface ParsedWorkflow {
  /** Original file path */
  filePath: string;
  /** Workflow name (from 'name' field or derived from filename) */
  name: string;
  /** Raw parsed workflow */
  workflow: Workflow;
  /** List of job IDs in dependency order */
  jobOrder: string[];
}

export interface MatrixCombination {
  [key: string]: string | number | boolean;
}

// =============================================================================
// Parsing Functions
// =============================================================================

/**
 * Parse a workflow YAML file.
 */
export function parseWorkflowFile(filePath: string): ParsedWorkflow {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Workflow file not found: ${absolutePath}`);
  }

  const content = fs.readFileSync(absolutePath, 'utf-8');
  return parseWorkflowContent(content, absolutePath);
}

/**
 * Parse workflow YAML content.
 */
export function parseWorkflowContent(content: string, filePath: string): ParsedWorkflow {
  let workflow: Workflow;

  try {
    workflow = yaml.load(content) as Workflow;
  } catch (err) {
    const yamlError = err as Error;
    throw new Error(`Invalid YAML in ${filePath}: ${yamlError.message}`);
  }

  // Validate required fields
  if (!workflow) {
    throw new Error(`Empty workflow file: ${filePath}`);
  }

  if (!workflow.jobs || Object.keys(workflow.jobs).length === 0) {
    throw new Error(`No jobs defined in workflow: ${filePath}`);
  }

  // Validate each job has required fields
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    // Check if this is a reusable workflow call
    if (job.uses) {
      // Reusable workflow jobs don't have runs-on or steps
      // They reference another workflow file
      continue;
    }

    // Regular job requires runs-on and steps
    if (!job['runs-on']) {
      throw new Error(`Job "${jobId}" is missing required 'runs-on' field`);
    }
    if (!job.steps || job.steps.length === 0) {
      throw new Error(`Job "${jobId}" has no steps defined`);
    }
  }

  // Derive name from file if not specified
  const name = workflow.name || path.basename(filePath, path.extname(filePath));

  // Compute job execution order based on dependencies
  const jobOrder = computeJobOrder(workflow.jobs);

  return {
    filePath,
    name,
    workflow,
    jobOrder,
  };
}

/**
 * Compute job execution order respecting dependencies.
 * Uses topological sort based on 'needs' declarations.
 */
function computeJobOrder(jobs: Record<string, WorkflowJob>): string[] {
  const jobIds = Object.keys(jobs);
  const visited = new Set<string>();
  const order: string[] = [];

  function visit(jobId: string, ancestors: Set<string>): void {
    if (ancestors.has(jobId)) {
      throw new Error(`Circular dependency detected involving job: ${jobId}`);
    }
    if (visited.has(jobId)) {
      return;
    }

    ancestors.add(jobId);

    const job = jobs[jobId];
    if (job.needs) {
      const deps = Array.isArray(job.needs) ? job.needs : [job.needs];
      for (const dep of deps) {
        if (!jobs[dep]) {
          throw new Error(`Job "${jobId}" depends on unknown job: ${dep}`);
        }
        visit(dep, new Set(ancestors));
      }
    }

    visited.add(jobId);
    order.push(jobId);
  }

  for (const jobId of jobIds) {
    visit(jobId, new Set());
  }

  return order;
}

// =============================================================================
// Discovery Functions
// =============================================================================

/**
 * Find all workflow files in a repository.
 */
export function findWorkflowFiles(repoRoot: string): string[] {
  const workflowDir = path.join(repoRoot, '.github', 'workflows');

  if (!fs.existsSync(workflowDir)) {
    return [];
  }

  const files = fs.readdirSync(workflowDir);
  return files
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => path.join(workflowDir, f))
    .sort();
}

/**
 * Find the default workflow to run.
 * Priority: ci.yml, build.yml, test.yml, first alphabetically.
 */
export function findDefaultWorkflow(repoRoot: string): string | null {
  const workflows = findWorkflowFiles(repoRoot);

  if (workflows.length === 0) {
    return null;
  }

  // Check for common default names
  const defaultNames = ['ci', 'build', 'test', 'main'];
  for (const name of defaultNames) {
    const match = workflows.find(
      (w) =>
        path.basename(w, '.yml') === name || path.basename(w, '.yaml') === name
    );
    if (match) {
      return match;
    }
  }

  // Fall back to first alphabetically
  return workflows[0];
}

// =============================================================================
// Matrix Functions
// =============================================================================

/**
 * Generate all matrix combinations for a job.
 */
export function generateMatrixCombinations(
  strategy?: MatrixStrategy
): MatrixCombination[] {
  if (!strategy?.matrix) {
    return [{}];
  }

  const matrix = strategy.matrix;
  const keys = Object.keys(matrix);

  if (keys.length === 0) {
    return [{}];
  }

  // Generate Cartesian product of all matrix dimensions
  function cartesian(
    remainingKeys: string[],
    current: MatrixCombination
  ): MatrixCombination[] {
    if (remainingKeys.length === 0) {
      return [{ ...current }];
    }

    const [key, ...rest] = remainingKeys;
    const values = matrix[key];
    const results: MatrixCombination[] = [];

    for (const value of values) {
      results.push(...cartesian(rest, { ...current, [key]: value }));
    }

    return results;
  }

  return cartesian(keys, {});
}

/**
 * Parse a matrix specification string like "os=macos-latest,node=18".
 */
export function parseMatrixSpec(spec: string): MatrixCombination {
  const result: MatrixCombination = {};

  const pairs = spec.split(',');
  for (const pair of pairs) {
    const [key, value] = pair.split('=').map((s) => s.trim());
    if (!key || value === undefined) {
      throw new Error(`Invalid matrix spec: ${pair}. Expected format: key=value`);
    }
    // Try to parse as number or boolean
    if (value === 'true') {
      result[key] = true;
    } else if (value === 'false') {
      result[key] = false;
    } else if (!isNaN(Number(value))) {
      result[key] = Number(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Find a matching matrix combination.
 */
export function findMatchingCombination(
  combinations: MatrixCombination[],
  spec: MatrixCombination
): MatrixCombination | null {
  return (
    combinations.find((combo) =>
      Object.entries(spec).every(([key, value]) => combo[key] === value)
    ) || null
  );
}

// =============================================================================
// Expression Evaluation
// =============================================================================

/**
 * Extract secret references from a workflow.
 * Returns a list of secret names used in ${{ secrets.* }} expressions.
 */
export function extractSecretReferences(workflow: Workflow): string[] {
  const secrets = new Set<string>();
  const secretPattern = /\$\{\{\s*secrets\.(\w+)\s*\}\}/g;

  function extractFromValue(value: unknown): void {
    if (typeof value === 'string') {
      let match;
      while ((match = secretPattern.exec(value)) !== null) {
        secrets.add(match[1]);
      }
    } else if (Array.isArray(value)) {
      value.forEach(extractFromValue);
    } else if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(extractFromValue);
    }
  }

  // Check workflow-level env
  if (workflow.env) {
    extractFromValue(workflow.env);
  }

  // Check each job
  for (const job of Object.values(workflow.jobs)) {
    if (job.env) {
      extractFromValue(job.env);
    }

    // Skip reusable workflow jobs (they have no steps)
    if (!job.steps) continue;

    for (const step of job.steps) {
      if (step.env) {
        extractFromValue(step.env);
      }
      if (step.run) {
        extractFromValue(step.run);
      }
      if (step.with) {
        extractFromValue(step.with);
      }
    }
  }

  return Array.from(secrets).sort();
}

/**
 * Extract environment variable references from expressions.
 */
export function extractEnvReferences(workflow: Workflow): string[] {
  const envVars = new Set<string>();
  const envPattern = /\$\{\{\s*env\.(\w+)\s*\}\}/g;

  function extractFromValue(value: unknown): void {
    if (typeof value === 'string') {
      let match;
      while ((match = envPattern.exec(value)) !== null) {
        envVars.add(match[1]);
      }
    } else if (Array.isArray(value)) {
      value.forEach(extractFromValue);
    } else if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(extractFromValue);
    }
  }

  for (const job of Object.values(workflow.jobs)) {
    // Skip reusable workflow jobs (they have no steps)
    if (!job.steps) continue;

    for (const step of job.steps) {
      if (step.run) {
        extractFromValue(step.run);
      }
      if (step.with) {
        extractFromValue(step.with);
      }
      if (step.if) {
        extractFromValue(step.if);
      }
    }
  }

  return Array.from(envVars).sort();
}

// =============================================================================
// Reusable Workflow Functions
// =============================================================================

/**
 * Check if a job is a reusable workflow call.
 */
export function isReusableWorkflowJob(job: WorkflowJob): boolean {
  return !!job.uses;
}

/**
 * Check if a workflow is a reusable workflow (has workflow_call trigger).
 */
export function isReusableWorkflow(workflow: Workflow): boolean {
  if (typeof workflow.on === 'string') {
    return workflow.on === 'workflow_call';
  }
  if (Array.isArray(workflow.on)) {
    return workflow.on.includes('workflow_call');
  }
  return 'workflow_call' in workflow.on;
}

/**
 * Parse a reusable workflow file, extracting its inputs and outputs.
 */
export function parseReusableWorkflow(filePath: string): ReusableWorkflow {
  const parsed = parseWorkflowFile(filePath);

  if (!isReusableWorkflow(parsed.workflow)) {
    throw new Error(`Workflow "${filePath}" is not a reusable workflow (missing workflow_call trigger)`);
  }

  // Extract inputs and outputs from workflow_call trigger
  let inputs: Record<string, WorkflowCallInput> = {};
  let outputs: Record<string, WorkflowCallOutput> = {};

  const on = parsed.workflow.on;
  if (typeof on === 'object' && !Array.isArray(on) && on.workflow_call) {
    const callTrigger = on.workflow_call as WorkflowCallTrigger;
    inputs = callTrigger.inputs || {};
    outputs = callTrigger.outputs || {};
  }

  return {
    ...parsed,
    inputs,
    outputs,
  };
}

/**
 * Resolve the file path for a reusable workflow reference.
 * Handles local references like "./.github/workflows/check.yaml".
 */
export function resolveReusableWorkflowPath(
  uses: string,
  callerWorkflowPath: string
): string | null {
  // Local workflow reference: ./.github/workflows/workflow.yaml
  if (uses.startsWith('./')) {
    const repoRoot = path.dirname(path.dirname(path.dirname(callerWorkflowPath)));
    return path.join(repoRoot, uses.slice(2));
  }

  // Remote workflow reference: owner/repo/.github/workflows/workflow.yaml@ref
  // Not supported yet
  if (uses.includes('/') && uses.includes('@')) {
    return null;
  }

  return null;
}

/**
 * Resolve inputs for a reusable workflow call.
 * Combines caller's `with` values with workflow defaults.
 */
export function resolveReusableWorkflowInputs(
  callerInputs: Record<string, string | number | boolean> | undefined,
  workflowInputDefs: Record<string, WorkflowCallInput>
): Record<string, string | number | boolean> {
  const resolved: Record<string, string | number | boolean> = {};

  for (const [name, def] of Object.entries(workflowInputDefs)) {
    if (callerInputs && name in callerInputs) {
      resolved[name] = callerInputs[name];
    } else if (def.default !== undefined) {
      resolved[name] = def.default;
    } else if (def.required) {
      throw new Error(`Required input "${name}" not provided for reusable workflow`);
    }
  }

  return resolved;
}
