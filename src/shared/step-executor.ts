/**
 * Step Executor
 *
 * Executes workflow steps (both `run:` and `uses:` steps) with sandbox
 * support and proper environment setup.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, SpawnOptions } from 'child_process';
import { WorkflowStep, WorkflowJob, MatrixCombination } from './workflow-parser';
import { SandboxPolicy, generateSandboxProfile } from './sandbox-profile';
import { parseActionRef, fetchAction, isInterceptedAction, readActionMetadata } from './action-fetcher';
import { getGitInfo } from './workspace';

// =============================================================================
// Types
// =============================================================================

export type StepStatus = 'pending' | 'running' | 'success' | 'failure' | 'skipped';

export interface StepResult {
  name: string;
  status: StepStatus;
  exitCode?: number;
  duration: number;
  outputs: Record<string, string>;
  error?: string;
}

export interface ExecutionContext {
  /** Working directory (GITHUB_WORKSPACE) */
  workDir: string;
  /** Workflow-level environment variables */
  workflowEnv: Record<string, string>;
  /** Job-level environment variables */
  jobEnv: Record<string, string>;
  /** Matrix values for this run */
  matrix: MatrixCombination;
  /** Secrets (name -> value) */
  secrets: Record<string, string>;
  /** Previous step outputs (step_id -> outputs) */
  stepOutputs: Record<string, Record<string, string>>;
  /** Inputs from workflow_call (for reusable workflows) */
  inputs?: Record<string, string | number | boolean>;
  /** Outputs from jobs this job depends on (needs context) */
  needs?: Record<string, Record<string, string>>;
  /** Sandbox policy to enforce */
  policy?: SandboxPolicy;
  /** Whether running in permissive/discovery mode */
  permissive?: boolean;
  /** Callback for step output */
  onOutput?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Callback for step status changes */
  onStatus?: (step: string, status: StepStatus) => void;
}

export interface JobExecutionOptions {
  job: WorkflowJob;
  jobId: string;
  context: ExecutionContext;
}

// =============================================================================
// Environment Setup
// =============================================================================

/**
 * Build the full environment for step execution.
 */
export function buildStepEnvironment(
  step: WorkflowStep,
  ctx: ExecutionContext,
  job: WorkflowJob
): Record<string, string> {
  const env: Record<string, string> = {
    // Preserve PATH and essential system vars
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || os.homedir(),
    USER: process.env.USER || '',
    SHELL: process.env.SHELL || '/bin/bash',
    TERM: process.env.TERM || 'xterm-256color',
    LANG: process.env.LANG || 'en_US.UTF-8',

    // GitHub Actions standard variables
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW: ctx.workflowEnv.GITHUB_WORKFLOW || 'local',
    GITHUB_RUN_ID: ctx.workflowEnv.GITHUB_RUN_ID || String(Date.now()),
    GITHUB_RUN_NUMBER: ctx.workflowEnv.GITHUB_RUN_NUMBER || '1',
    GITHUB_JOB: ctx.jobEnv.GITHUB_JOB || 'local',
    GITHUB_ACTION: step.id || step.name || 'step',
    GITHUB_ACTOR: process.env.USER || 'local',
    GITHUB_REPOSITORY: ctx.workflowEnv.GITHUB_REPOSITORY || 'local/repo',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKSPACE: ctx.workDir,
    GITHUB_SHA: ctx.workflowEnv.GITHUB_SHA || '',
    GITHUB_REF: ctx.workflowEnv.GITHUB_REF || '',
    GITHUB_HEAD_REF: '',
    GITHUB_BASE_REF: '',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_API_URL: 'https://api.github.com',
    GITHUB_GRAPHQL_URL: 'https://api.github.com/graphql',
    GITHUB_ENV: path.join(ctx.workDir, '.github-env'),
    GITHUB_PATH: path.join(ctx.workDir, '.github-path'),
    GITHUB_OUTPUT: path.join(ctx.workDir, '.github-output'),
    GITHUB_STEP_SUMMARY: path.join(ctx.workDir, '.github-step-summary'),

    // Runner information
    RUNNER_NAME: 'localmost',
    RUNNER_OS: 'macOS',
    RUNNER_ARCH: process.arch === 'arm64' ? 'ARM64' : 'X64',
    RUNNER_TEMP: path.join(ctx.workDir, '.runner-temp'),
    RUNNER_TOOL_CACHE: path.join(os.homedir(), '.localmost', 'tool-cache'),

    // ImageOS for setup-* actions
    ImageOS: 'macos14',
  };

  // Add workflow-level env
  Object.assign(env, ctx.workflowEnv);

  // Add job-level env
  Object.assign(env, ctx.jobEnv);

  // Add job defaults if present
  if (job.defaults?.run?.['working-directory']) {
    env.GITHUB_WORKSPACE = path.join(ctx.workDir, job.defaults.run['working-directory']);
  }

  // Add step-level env
  if (step.env) {
    Object.assign(env, expandEnvValues(step.env, env, ctx));
  }

  // Add matrix values
  for (const [key, value] of Object.entries(ctx.matrix)) {
    env[`MATRIX_${key.toUpperCase()}`] = String(value);
  }

  // Expose secrets (with masking warning)
  for (const [name, value] of Object.entries(ctx.secrets)) {
    env[name] = value;
  }

  return env;
}

/**
 * Expand environment variable references and expressions in values.
 */
function expandEnvValues(
  envMap: Record<string, string>,
  currentEnv: Record<string, string>,
  ctx: ExecutionContext
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(envMap)) {
    result[key] = expandExpression(String(value), currentEnv, ctx);
  }

  return result;
}

/**
 * Expand GitHub Actions expressions like ${{ env.FOO }} and ${{ secrets.BAR }}.
 */
export function expandExpression(
  expr: string,
  env: Record<string, string>,
  ctx: ExecutionContext
): string {
  return expr.replace(/\$\{\{\s*([^}]+)\s*\}\}/g, (match, expression: string) => {
    const trimmed = expression.trim();

    // env.VAR
    if (trimmed.startsWith('env.')) {
      const varName = trimmed.slice(4);
      return env[varName] || '';
    }

    // secrets.VAR
    if (trimmed.startsWith('secrets.')) {
      const secretName = trimmed.slice(8);
      return ctx.secrets[secretName] || '';
    }

    // matrix.VAR
    if (trimmed.startsWith('matrix.')) {
      const matrixKey = trimmed.slice(7);
      const value = ctx.matrix[matrixKey];
      return value !== undefined ? String(value) : '';
    }

    // steps.STEP_ID.outputs.VAR
    const stepsMatch = trimmed.match(/^steps\.([^.]+)\.outputs\.(.+)$/);
    if (stepsMatch) {
      const [, stepId, outputName] = stepsMatch;
      return ctx.stepOutputs[stepId]?.[outputName] || '';
    }

    // inputs.VAR (for reusable workflows)
    if (trimmed.startsWith('inputs.')) {
      const inputName = trimmed.slice(7);
      const value = ctx.inputs?.[inputName];
      return value !== undefined ? String(value) : '';
    }

    // needs.JOB_ID.outputs.VAR
    const needsMatch = trimmed.match(/^needs\.([^.]+)\.outputs\.(.+)$/);
    if (needsMatch) {
      const [, jobId, outputName] = needsMatch;
      return ctx.needs?.[jobId]?.[outputName] || '';
    }

    // github.* context
    if (trimmed.startsWith('github.')) {
      const prop = trimmed.slice(7);
      const githubCtx: Record<string, string> = {
        sha: env.GITHUB_SHA || '',
        ref: env.GITHUB_REF || '',
        repository: env.GITHUB_REPOSITORY || '',
        workspace: env.GITHUB_WORKSPACE || '',
        actor: env.GITHUB_ACTOR || '',
        event_name: env.GITHUB_EVENT_NAME || '',
      };
      return githubCtx[prop] || '';
    }

    // runner.* context
    if (trimmed.startsWith('runner.')) {
      const prop = trimmed.slice(7);
      const runnerCtx: Record<string, string> = {
        os: 'macOS',
        arch: process.arch === 'arm64' ? 'ARM64' : 'X64',
        name: 'localmost',
        temp: env.RUNNER_TEMP || '',
        tool_cache: env.RUNNER_TOOL_CACHE || '',
      };
      return runnerCtx[prop] || '';
    }

    // Unknown expression, leave as-is
    return match;
  });
}

// =============================================================================
// Step Execution
// =============================================================================

/**
 * Execute a single workflow step.
 */
export async function executeStep(
  step: WorkflowStep,
  ctx: ExecutionContext,
  job: WorkflowJob
): Promise<StepResult> {
  const stepName = step.name || step.id || (step.uses ? `Run ${step.uses}` : 'Run script');
  const startTime = Date.now();

  ctx.onStatus?.(stepName, 'running');

  // Check if step should be skipped
  if (step.if) {
    const shouldRun = evaluateCondition(step.if, ctx);
    if (!shouldRun) {
      ctx.onStatus?.(stepName, 'skipped');
      return {
        name: stepName,
        status: 'skipped',
        duration: 0,
        outputs: {},
      };
    }
  }

  try {
    let result: StepResult;

    if (step.uses) {
      // Action step
      result = await executeActionStep(step, ctx, job, stepName);
    } else if (step.run) {
      // Run step
      result = await executeRunStep(step, ctx, job, stepName);
    } else {
      throw new Error('Step must have either "uses" or "run"');
    }

    result.duration = Date.now() - startTime;
    ctx.onStatus?.(stepName, result.status);

    // Store outputs for use by later steps
    if (step.id && Object.keys(result.outputs).length > 0) {
      ctx.stepOutputs[step.id] = result.outputs;
    }

    return result;
  } catch (err) {
    const duration = Date.now() - startTime;
    const error = err instanceof Error ? err.message : String(err);

    ctx.onStatus?.(stepName, step['continue-on-error'] ? 'success' : 'failure');

    return {
      name: stepName,
      status: step['continue-on-error'] ? 'success' : 'failure',
      duration,
      outputs: {},
      error,
    };
  }
}

/**
 * Execute a `run:` step.
 */
async function executeRunStep(
  step: WorkflowStep,
  ctx: ExecutionContext,
  job: WorkflowJob,
  stepName: string
): Promise<StepResult> {
  const env = buildStepEnvironment(step, ctx, job);
  const shell = step.shell || job.defaults?.run?.shell || 'bash';
  const workingDir =
    step['working-directory'] ||
    job.defaults?.run?.['working-directory'] ||
    ctx.workDir;

  // Expand expressions in the script
  const script = expandExpression(step.run!, env, ctx);

  // Create GITHUB_OUTPUT file
  const outputFile = env.GITHUB_OUTPUT;
  fs.writeFileSync(outputFile, '');

  // Create temp script file
  const scriptFile = path.join(ctx.workDir, `.step-${Date.now()}.sh`);
  fs.writeFileSync(scriptFile, script, { mode: 0o755 });

  try {
    const exitCode = await runInSandbox(
      shell,
      [scriptFile],
      {
        cwd: workingDir,
        env,
        onOutput: ctx.onOutput,
      },
      ctx.policy,
      ctx.permissive
    );

    // Parse outputs from GITHUB_OUTPUT file
    const outputs = parseGitHubOutputFile(outputFile);

    // Clean up
    fs.unlinkSync(scriptFile);

    return {
      name: stepName,
      status: exitCode === 0 ? 'success' : 'failure',
      exitCode,
      duration: 0,
      outputs,
    };
  } finally {
    // Ensure cleanup
    if (fs.existsSync(scriptFile)) {
      fs.unlinkSync(scriptFile);
    }
  }
}

/**
 * Execute a `uses:` action step.
 */
async function executeActionStep(
  step: WorkflowStep,
  ctx: ExecutionContext,
  job: WorkflowJob,
  stepName: string
): Promise<StepResult> {
  const uses = step.uses!;

  // Check for intercepted actions
  if (isInterceptedAction(uses)) {
    return await executeInterceptedAction(step, ctx, job, stepName);
  }

  // Check for local actions
  if (uses.startsWith('./') || uses.startsWith('../')) {
    return await executeLocalAction(step, ctx, job, stepName);
  }

  // Fetch and run the action
  const ref = parseActionRef(uses);
  if (!ref) {
    throw new Error(`Cannot parse action reference: ${uses}`);
  }

  ctx.onOutput?.(`Fetching action ${uses}...`, 'stdout');
  const cached = await fetchAction(ref);

  return await executeActionFromPath(cached.localPath, step, ctx, job, stepName);
}

/**
 * Execute a local action (./path/to/action).
 */
async function executeLocalAction(
  step: WorkflowStep,
  ctx: ExecutionContext,
  job: WorkflowJob,
  stepName: string
): Promise<StepResult> {
  const actionPath = path.join(ctx.workDir, step.uses!);
  return await executeActionFromPath(actionPath, step, ctx, job, stepName);
}

/**
 * Execute an action from a local path.
 */
async function executeActionFromPath(
  actionPath: string,
  step: WorkflowStep,
  ctx: ExecutionContext,
  job: WorkflowJob,
  stepName: string
): Promise<StepResult> {
  const metadata = readActionMetadata(actionPath);
  if (!metadata) {
    throw new Error(`No action.yml found in ${actionPath}`);
  }

  const env = buildStepEnvironment(step, ctx, job);

  // Add action inputs as INPUT_* env vars
  if (step.with) {
    for (const [key, value] of Object.entries(step.with)) {
      const inputName = key.toUpperCase().replace(/-/g, '_');
      env[`INPUT_${inputName}`] = expandExpression(String(value), env, ctx);
    }
  }

  // Add default values for missing inputs
  if (metadata.inputs) {
    for (const [key, input] of Object.entries(metadata.inputs)) {
      const inputName = key.toUpperCase().replace(/-/g, '_');
      if (!env[`INPUT_${inputName}`] && input.default !== undefined) {
        env[`INPUT_${inputName}`] = input.default;
      }
    }
  }

  // Create GITHUB_OUTPUT file
  const outputFile = env.GITHUB_OUTPUT;
  fs.writeFileSync(outputFile, '');

  // Execute based on action type
  const { using, main } = metadata.runs;

  if (using === 'composite') {
    // Composite actions - run their steps
    return await executeCompositeAction(metadata, step, ctx, job, stepName);
  }

  if (using.startsWith('node')) {
    // Node.js action
    if (!main) {
      throw new Error('Node action missing "main" entry point');
    }

    const mainPath = path.join(actionPath, main);
    const exitCode = await runInSandbox(
      'node',
      [mainPath],
      {
        cwd: actionPath,
        env,
        onOutput: ctx.onOutput,
      },
      ctx.policy,
      ctx.permissive
    );

    const outputs = parseGitHubOutputFile(outputFile);

    return {
      name: stepName,
      status: exitCode === 0 ? 'success' : 'failure',
      exitCode,
      duration: 0,
      outputs,
    };
  }

  if (using === 'docker') {
    throw new Error('Docker actions are not supported in local test mode');
  }

  throw new Error(`Unsupported action type: ${using}`);
}

/**
 * Execute a composite action by running its nested steps.
 */
async function executeCompositeAction(
  metadata: { runs: { steps?: unknown[] }; inputs?: Record<string, { default?: string }> },
  step: WorkflowStep,
  ctx: ExecutionContext,
  job: WorkflowJob,
  stepName: string
): Promise<StepResult> {
  const startTime = Date.now();
  const compositeSteps = metadata.runs.steps as WorkflowStep[] | undefined;

  if (!compositeSteps || compositeSteps.length === 0) {
    return {
      name: stepName,
      status: 'success',
      duration: 0,
      outputs: {},
    };
  }

  ctx.onOutput?.(`Running composite action with ${compositeSteps.length} steps`, 'stdout');

  // Create a new context for the composite action with its own step outputs
  const compositeCtx: ExecutionContext = {
    ...ctx,
    stepOutputs: { ...ctx.stepOutputs },
  };

  // Add inputs to the environment for the composite steps
  if (step.with) {
    for (const [key, value] of Object.entries(step.with)) {
      const inputName = key.toUpperCase().replace(/-/g, '_');
      compositeCtx.workflowEnv[`INPUT_${inputName}`] = String(value);
    }
  }

  const allOutputs: Record<string, string> = {};
  let overallStatus: StepStatus = 'success';

  for (let i = 0; i < compositeSteps.length; i++) {
    const compositeStep = compositeSteps[i];
    const stepDisplayName = compositeStep.name || compositeStep.id || `Step ${i + 1}`;

    ctx.onOutput?.(`  [${i + 1}/${compositeSteps.length}] ${stepDisplayName}`, 'stdout');

    const result = await executeStep(compositeStep, compositeCtx, job);

    // Merge outputs from this step
    Object.assign(allOutputs, result.outputs);

    if (result.status === 'failure') {
      overallStatus = 'failure';
      // Stop on first failure unless continue-on-error is set
      if (!compositeStep['continue-on-error']) {
        return {
          name: stepName,
          status: 'failure',
          duration: Date.now() - startTime,
          outputs: allOutputs,
          error: result.error || `Step "${stepDisplayName}" failed`,
        };
      }
    }
  }

  return {
    name: stepName,
    status: overallStatus,
    duration: Date.now() - startTime,
    outputs: allOutputs,
  };
}

/**
 * Execute an intercepted action (checkout, cache, etc.).
 */
async function executeInterceptedAction(
  step: WorkflowStep,
  ctx: ExecutionContext,
  _job: WorkflowJob,
  stepName: string
): Promise<StepResult> {
  const uses = step.uses!;

  // actions/checkout
  if (uses.startsWith('actions/checkout')) {
    return executeCheckoutIntercept(step, ctx, stepName);
  }

  // actions/cache (restore and save variants)
  if (uses.startsWith('actions/cache')) {
    // actions/cache/save is for saving only
    if (uses.includes('/save')) {
      return executeCacheSaveIntercept(step, ctx, stepName);
    }
    // actions/cache/restore is for restore only, regular actions/cache does both
    return executeCacheIntercept(step, ctx, stepName);
  }

  // actions/upload-artifact
  if (uses.startsWith('actions/upload-artifact')) {
    return executeUploadArtifactIntercept(step, ctx, stepName);
  }

  // actions/download-artifact
  if (uses.startsWith('actions/download-artifact')) {
    return executeDownloadArtifactIntercept(step, ctx, stepName);
  }

  // Fallback - just skip with a notice
  ctx.onOutput?.(`Stubbed: ${uses} (not implemented locally)`, 'stdout');
  return {
    name: stepName,
    status: 'success',
    duration: 0,
    outputs: {},
  };
}

/**
 * Intercept actions/checkout - use local working tree.
 */
function executeCheckoutIntercept(
  step: WorkflowStep,
  ctx: ExecutionContext,
  stepName: string
): StepResult {
  const repository = step.with?.repository as string | undefined;

  // If checking out a different repo, we can't intercept
  if (repository && repository !== ctx.workflowEnv.GITHUB_REPOSITORY) {
    ctx.onOutput?.(`Note: Checking out ${repository} would require network access`, 'stdout');
    return {
      name: stepName,
      status: 'success',
      duration: 0,
      outputs: {},
    };
  }

  // Use local working tree
  const gitInfo = getGitInfo(ctx.workDir);
  if (gitInfo) {
    ctx.workflowEnv.GITHUB_SHA = gitInfo.sha;
    ctx.workflowEnv.GITHUB_REF = gitInfo.ref;
  }

  ctx.onOutput?.('Using local working tree (checkout intercepted)', 'stdout');

  // Handle submodules
  if (step.with?.submodules === 'true' || step.with?.submodules === true) {
    ctx.onOutput?.('Updating submodules...', 'stdout');
    try {
      const { execSync } = require('child_process');
      execSync('git submodule update --init --recursive', {
        cwd: ctx.workDir,
        stdio: 'pipe',
      });
    } catch (err) {
      ctx.onOutput?.(`Warning: Failed to update submodules: ${(err as Error).message}`, 'stderr');
    }
  }

  return {
    name: stepName,
    status: 'success',
    duration: 0,
    outputs: {},
  };
}

/**
 * Get the local cache directory for workflow caches.
 */
function getLocalCacheDir(): string {
  return path.join(os.homedir(), '.localmost', 'workflow-cache');
}

/**
 * Create a safe directory name from a cache key.
 */
function sanitizeCacheKey(key: string): string {
  // Replace unsafe characters with underscores
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

/**
 * Intercept actions/cache - use local cache directory.
 */
function executeCacheIntercept(
  step: WorkflowStep,
  ctx: ExecutionContext,
  stepName: string
): StepResult {
  const key = step.with?.key as string | undefined;
  const cachePath = step.with?.path as string | undefined;
  const restoreKeys = step.with?.['restore-keys'] as string | undefined;

  if (!key || !cachePath) {
    ctx.onOutput?.('Cache: missing key or path', 'stdout');
    return {
      name: stepName,
      status: 'success',
      duration: 0,
      outputs: { 'cache-hit': 'false' },
    };
  }

  ctx.onOutput?.(`Cache (local): key=${key}, path=${cachePath}`, 'stdout');

  const cacheDir = getLocalCacheDir();
  const sanitizedKey = sanitizeCacheKey(key);
  const cacheEntryDir = path.join(cacheDir, sanitizedKey);

  // Check for exact match first
  if (fs.existsSync(cacheEntryDir)) {
    ctx.onOutput?.(`Cache hit: ${key}`, 'stdout');
    return restoreCacheEntry(cacheEntryDir, cachePath, ctx, stepName, true);
  }

  // Check restore keys for prefix match
  if (restoreKeys) {
    const prefixes = restoreKeys.split('\n').map(k => k.trim()).filter(Boolean);
    try {
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      const entries = fs.readdirSync(cacheDir);

      for (const prefix of prefixes) {
        const sanitizedPrefix = sanitizeCacheKey(prefix);
        // Find entries that start with this prefix
        const match = entries.find(entry => entry.startsWith(sanitizedPrefix));
        if (match) {
          ctx.onOutput?.(`Cache restored from key prefix: ${prefix}`, 'stdout');
          return restoreCacheEntry(path.join(cacheDir, match), cachePath, ctx, stepName, false);
        }
      }
    } catch (err) {
      ctx.onOutput?.(`Cache lookup error: ${(err as Error).message}`, 'stderr');
    }
  }

  ctx.onOutput?.('Cache miss', 'stdout');
  return {
    name: stepName,
    status: 'success',
    duration: 0,
    outputs: { 'cache-hit': 'false' },
  };
}

/**
 * Restore a cache entry to the workspace.
 */
function restoreCacheEntry(
  cacheEntryDir: string,
  targetPath: string,
  ctx: ExecutionContext,
  stepName: string,
  exactMatch: boolean
): StepResult {
  try {
    // Handle multiple paths separated by newlines
    const paths = targetPath.split('\n').map(p => p.trim()).filter(Boolean);

    for (const singlePath of paths) {
      const absoluteTarget = path.isAbsolute(singlePath)
        ? singlePath
        : path.join(ctx.workDir, singlePath);

      const cachedPath = path.join(cacheEntryDir, sanitizeCacheKey(singlePath));

      if (fs.existsSync(cachedPath)) {
        // Ensure parent directory exists
        const parentDir = path.dirname(absoluteTarget);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        // Copy cached files to target
        copyDirRecursive(cachedPath, absoluteTarget);
        ctx.onOutput?.(`  Restored: ${singlePath}`, 'stdout');
      }
    }

    return {
      name: stepName,
      status: 'success',
      duration: 0,
      outputs: { 'cache-hit': exactMatch ? 'true' : 'false' },
    };
  } catch (err) {
    ctx.onOutput?.(`Cache restore error: ${(err as Error).message}`, 'stderr');
    return {
      name: stepName,
      status: 'success',
      duration: 0,
      outputs: { 'cache-hit': 'false' },
    };
  }
}

/**
 * Copy a directory recursively.
 */
function copyDirRecursive(src: string, dest: string): void {
  const stat = fs.statSync(src);

  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    for (const entry of fs.readdirSync(src)) {
      copyDirRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

/**
 * Intercept actions/cache/save - save to local cache directory.
 */
function executeCacheSaveIntercept(
  step: WorkflowStep,
  ctx: ExecutionContext,
  stepName: string
): StepResult {
  const key = step.with?.key as string | undefined;
  const cachePath = step.with?.path as string | undefined;

  if (!key || !cachePath) {
    ctx.onOutput?.('Cache save: missing key or path', 'stdout');
    return {
      name: stepName,
      status: 'success',
      duration: 0,
      outputs: {},
    };
  }

  ctx.onOutput?.(`Cache save (local): key=${key}, path=${cachePath}`, 'stdout');

  const cacheDir = getLocalCacheDir();
  const sanitizedKey = sanitizeCacheKey(key);
  const cacheEntryDir = path.join(cacheDir, sanitizedKey);

  try {
    // Handle multiple paths separated by newlines
    const paths = cachePath.split('\n').map(p => p.trim()).filter(Boolean);

    // Create cache entry directory
    if (!fs.existsSync(cacheEntryDir)) {
      fs.mkdirSync(cacheEntryDir, { recursive: true });
    }

    for (const singlePath of paths) {
      const absoluteSource = path.isAbsolute(singlePath)
        ? singlePath
        : path.join(ctx.workDir, singlePath);

      if (fs.existsSync(absoluteSource)) {
        const cachedPath = path.join(cacheEntryDir, sanitizeCacheKey(singlePath));
        copyDirRecursive(absoluteSource, cachedPath);
        ctx.onOutput?.(`  Saved: ${singlePath}`, 'stdout');
      } else {
        ctx.onOutput?.(`  Skipped (not found): ${singlePath}`, 'stdout');
      }
    }

    return {
      name: stepName,
      status: 'success',
      duration: 0,
      outputs: {},
    };
  } catch (err) {
    ctx.onOutput?.(`Cache save error: ${(err as Error).message}`, 'stderr');
    return {
      name: stepName,
      status: 'success', // Cache save failure shouldn't fail the workflow
      duration: 0,
      outputs: {},
    };
  }
}

/**
 * Intercept actions/upload-artifact - save to local directory.
 */
function executeUploadArtifactIntercept(
  step: WorkflowStep,
  ctx: ExecutionContext,
  stepName: string
): StepResult {
  const name = step.with?.name as string | undefined || 'artifact';
  const artifactPath = step.with?.path as string | undefined;

  const artifactsDir = path.join(ctx.workDir, '.localmost-artifacts');
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  ctx.onOutput?.(`Artifact stubbed: ${name} (would upload ${artifactPath})`, 'stdout');
  ctx.onOutput?.(`Artifacts would be saved to: ${artifactsDir}`, 'stdout');

  return {
    name: stepName,
    status: 'success',
    duration: 0,
    outputs: {},
  };
}

/**
 * Intercept actions/download-artifact - look for local artifacts.
 */
function executeDownloadArtifactIntercept(
  step: WorkflowStep,
  ctx: ExecutionContext,
  stepName: string
): StepResult {
  const name = step.with?.name as string | undefined || 'artifact';

  ctx.onOutput?.(`Artifact download stubbed: ${name}`, 'stdout');
  ctx.onOutput?.('Local artifact download not implemented yet', 'stdout');

  return {
    name: stepName,
    status: 'success',
    duration: 0,
    outputs: {},
  };
}

// =============================================================================
// Sandbox Execution
// =============================================================================

/**
 * Run a command in the sandbox.
 */
async function runInSandbox(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    onOutput?: (line: string, stream: 'stdout' | 'stderr') => void;
  },
  policy?: SandboxPolicy,
  permissive?: boolean
): Promise<number> {
  return new Promise((resolve, reject) => {
    let spawnArgs: string[];
    let spawnCommand: string;

    if (process.platform === 'darwin' && policy) {
      // Generate sandbox profile
      const profile = generateSandboxProfile({
        workDir: options.cwd,
        policy,
        permissive,
      });

      // Write profile to temp file
      const profilePath = path.join(os.tmpdir(), `localmost-sandbox-${Date.now()}.sb`);
      fs.writeFileSync(profilePath, profile);

      spawnCommand = '/usr/bin/sandbox-exec';
      spawnArgs = ['-f', profilePath, command, ...args];
    } else {
      spawnCommand = command;
      spawnArgs = args;
    }

    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    const proc = spawn(spawnCommand, spawnArgs, spawnOptions);

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line) {
          options.onOutput?.(line, 'stdout');
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line) {
          options.onOutput?.(line, 'stderr');
        }
      }
    });

    proc.on('close', (code) => {
      resolve(code ?? 1);
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Parse the GITHUB_OUTPUT file format.
 * Format: name=value or name<<EOF\nvalue\nEOF
 */
function parseGitHubOutputFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const outputs: Record<string, string> = {};

  const lines = content.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Check for heredoc format: name<<DELIMITER
    const heredocMatch = line.match(/^([^=]+)<<(.+)$/);
    if (heredocMatch) {
      const [, name, delimiter] = heredocMatch;
      const valueLines: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) {
        valueLines.push(lines[i]);
        i++;
      }
      outputs[name] = valueLines.join('\n');
      i++;
      continue;
    }

    // Simple format: name=value
    const simpleMatch = line.match(/^([^=]+)=(.*)$/);
    if (simpleMatch) {
      const [, name, value] = simpleMatch;
      outputs[name] = value;
    }

    i++;
  }

  return outputs;
}

/**
 * Evaluate a step condition.
 * This is a simplified implementation - full expression support would require more work.
 */
function evaluateCondition(condition: string, _ctx: ExecutionContext): boolean {
  // Always run conditions
  if (condition === 'always()') {
    return true;
  }

  // Success/failure conditions
  if (condition === 'success()') {
    return true; // Assume previous steps succeeded
  }

  if (condition === 'failure()') {
    return false; // No previous failures in simple case
  }

  // Cancelled condition
  if (condition === 'cancelled()') {
    return false;
  }

  // For now, default to running the step
  return true;
}
