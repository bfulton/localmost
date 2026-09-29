/**
 * Step Executor
 *
 * Executes workflow steps (both `run:` and `uses:` steps) with sandbox
 * support and proper environment setup.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import { WorkflowStep, WorkflowJob, MatrixCombination } from './workflow-parser';
import { SandboxPolicy, generateSandboxProfile, generateDiscoveryProfile } from './sandbox-profile';
import { PidTreeWatcher } from './pid-tree-watch';
import { parseActionRef, fetchAction, isInterceptedAction, readActionMetadata } from './action-fetcher';
import { getGitInfo } from './workspace';
import { resolveWithin } from './contained-path';
import { getAppDataDirWithoutElectron } from './paths';

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
  /** Port of the proxy server for network isolation */
  proxyPort: number;
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
  /** Log file for sandbox trace output (for discovery mode) */
  sandboxLogFile?: string;
  /** Collected PIDs from sandbox processes (for discovery mode log filtering) */
  collectedPids?: Set<number>;
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
 * How many trailing characters could still turn out to be the start of a secret.
 */
function partialSecretSuffixLength(text: string, values: string[]): number {
  let hold = 0;
  for (const value of values) {
    for (let n = Math.min(value.length - 1, text.length); n > hold; n--) {
      if (text.endsWith(value.slice(0, n))) {
        hold = n;
        break;
      }
    }
  }
  return hold;
}

/**
 * Mask secrets across a stream whose chunk boundaries are arbitrary.
 *
 * Masking each chunk on its own misses any secret the runtime happens to split
 * in two, which is the case that matters: the halves look innocuous and the
 * value lands in the log intact. This holds back the longest tail that could
 * still become a secret, and releases it once the next chunk decides.
 *
 * `flush` must be called at end of stream to emit whatever is still held.
 */
export function createSecretMasker(secrets: Record<string, string>): {
  push(chunk: string): string;
  flush(): string;
} {
  const values = Object.values(secrets).filter((v) => v && v.length >= 4);
  let held = '';

  return {
    push(chunk: string): string {
      if (values.length === 0) return chunk;
      const masked = maskSecrets(held + chunk, secrets);
      const hold = partialSecretSuffixLength(masked, values);
      held = hold > 0 ? masked.slice(masked.length - hold) : '';
      return hold > 0 ? masked.slice(0, masked.length - hold) : masked;
    },
    flush(): string {
      const out = maskSecrets(held, secrets);
      held = '';
      return out;
    },
  };
}

/**
 * Create the workspace-local HOME a step runs with.
 *
 * Every step gets HOME inside the workspace, so every path that builds a step
 * environment needs the directory to exist - not just `run:` steps.
 */
export function ensureStepHome(workDir: string): string {
  const stepHome = path.join(workDir, '.home');
  if (!fs.existsSync(stepHome)) {
    fs.mkdirSync(stepHome, { recursive: true });
  }
  return stepHome;
}

/**
 * Replace secret values with *** wherever they appear.
 *
 * A step can print a secret by accident - `set -x`, a curl error echoing a
 * URL, a tool dumping its config - and localmost streams step output to the
 * console and the log file. GitHub masks secrets in job logs for the same
 * reason; without it, running a workflow locally is a way to spill one.
 */
export function maskSecrets(text: string, secrets: Record<string, string>): string {
  let masked = text;
  for (const value of Object.values(secrets)) {
    // Very short values would match everywhere and make output unreadable.
    if (!value || value.length < 4) continue;
    masked = masked.split(value).join('***');
  }
  return masked;
}

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
    // A home inside the workspace, not the user's. GitHub Actions gives a step
    // the runner's home, and pointing at the real one both diverges from that
    // and sends every tool looking for dotfiles the sandbox denies - git dies
    // on ~/.gitconfig before it does anything.
    HOME: ensureStepHome(ctx.workDir),
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
    // Per run, like RUNNER_TEMP. A cache shared across runs is one a checkout
    // can poison for the next, and the app's data directory, where it used to
    // live, is closed to steps.
    RUNNER_TOOL_CACHE: path.join(ctx.workDir, '.runner-tool-cache'),

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

  // Secrets are deliberately not exported here. GitHub does not put them in a
  // step's environment; they reach a step only through ${{ secrets.X }}, which
  // includes an explicit `env:` mapping. Exporting them all would hand every
  // secret to every child process of every step.

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
  // Relative to the workspace, as on GitHub, and never outside it. This is
  // only where the step starts; its sandbox is rooted at the workspace either
  // way.
  const namedDir = step['working-directory'] || job.defaults?.run?.['working-directory'];
  const workingDir = namedDir
    ? resolveWithin(ctx.workDir, namedDir, 'working-directory')
    : ctx.workDir;

  // Expand expressions in the script
  const script = expandExpression(step.run!, env, ctx);

  // Create GITHUB_OUTPUT file
  const outputFile = env.GITHUB_OUTPUT;
  fs.writeFileSync(outputFile, '');

  // Create temp script file
  const scriptFile = path.join(ctx.workDir, `.step-${Date.now()}.sh`);
  // 0700, not 0755: expanding ${{ secrets.X }} puts the value in this file for
  // as long as the step runs, and another account should not be able to read it.
  fs.writeFileSync(scriptFile, script, { mode: 0o700 });

  ensureStepHome(ctx.workDir);

  try {
    const result = await runInSandbox(
      shell,
      [scriptFile],
      {
        cwd: workingDir,
        workDir: ctx.workDir,
        env,
        proxyPort: ctx.proxyPort,
        onOutput: ctx.onOutput,
        sandboxLogFile: ctx.sandboxLogFile,
        collectedPids: ctx.collectedPids,
        secrets: ctx.secrets,
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
      status: result.exitCode === 0 ? 'success' : 'failure',
      exitCode: result.exitCode,
      duration: 0,
      outputs,
      error: result.exitCode !== 0 && result.stderr ? result.stderr : undefined,
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
  const actionPath = resolveWithin(ctx.workDir, step.uses!, 'Local action');
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

    // GitHub runs a node action from the workspace, not from its own
    // directory. Its code is readable and nothing more: an action directory
    // fetched into the app's cache is shared by every run that uses it.
    const mainPath = resolveWithin(actionPath, main, 'Action entry point', 'the action');
    const result = await runInSandbox(
      'node',
      [mainPath],
      {
        cwd: ctx.workDir,
        workDir: ctx.workDir,
        readOnlyPaths: [actionPath],
        env,
        proxyPort: ctx.proxyPort,
        onOutput: ctx.onOutput,
        sandboxLogFile: ctx.sandboxLogFile,
        collectedPids: ctx.collectedPids,
        secrets: ctx.secrets,
      },
      ctx.policy,
      ctx.permissive
    );

    const outputs = parseGitHubOutputFile(outputFile);

    return {
      name: stepName,
      status: result.exitCode === 0 ? 'success' : 'failure',
      exitCode: result.exitCode,
      duration: 0,
      outputs,
      error: result.exitCode !== 0 && result.stderr ? result.stderr : undefined,
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

interface SandboxResult {
  exitCode: number;
  stderr: string;
}

/**
 * Write a step's profile where no step can reach it.
 *
 * The profile is what confines the step, so it must not live anywhere a step
 * or a runner job can write. It used to go in os.tmpdir() under a name taken
 * from the clock, written without O_EXCL and never removed: a sandboxed
 * process could plant a symlink at the next name and have this write go
 * through it, or swap a profile before sandbox-exec read it. It goes in the
 * app's own data directory now, which the profiles deny, in a fresh private
 * directory, created exclusively. Removed once the step is done unless
 * LOCALMOST_KEEP_SANDBOX_PROFILES is set, as for the runner's profiles.
 */
function writeStepProfile(profile: string): { profilePath: string; remove: () => void } {
  const base = path.join(getAppDataDirWithoutElectron(), 'test-sandbox-profiles');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(base, 'step-'));
  const profilePath = path.join(dir, 'profile.sb');
  fs.writeFileSync(profilePath, profile, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  let removed = false;
  return {
    profilePath,
    remove: () => {
      if (removed || process.env.LOCALMOST_KEEP_SANDBOX_PROFILES) return;
      removed = true;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The process groups this job's steps lead, by leader pid, and whether the
 * leader has exited.
 */
const stepProcessGroups = new Map<number, boolean>();

/** Remember a step's process group, so reapStepProcesses can end it. */
export function trackStepProcessGroup(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid || pid <= 1) return;
  stepProcessGroups.set(pid, false);
  proc.once('exit', () => {
    if (stepProcessGroups.has(pid)) stepProcessGroups.set(pid, true);
  });
}

/**
 * Kill whatever this job's steps left running.
 *
 * A step can background a process that outlives it - reparented to launchd,
 * nothing would ever end it - and one from an untrusted checkout keeps
 * whatever the sandbox gave it for as long as it lives. Called when a job
 * ends, as GitHub's runner cleans up orphans at the end of a job and not the
 * end of a step, so a server one step starts is still there for the next.
 *
 * A pid is never reused while it names a live process group, so while the
 * group has members its leader's pid addresses exactly them. Once the leader
 * has exited, a live process with that pid means the group emptied and the
 * pid was reused: that group is someone else's, and is left alone.
 */
export function reapStepProcesses(): void {
  for (const [pgid, leaderExited] of stepProcessGroups) {
    if (leaderExited) {
      try {
        process.kill(pgid, 0);
        continue;
      } catch {
        // No process has the pid, so whatever is left in the group is ours.
      }
    }
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already empty.
    }
  }
  stepProcessGroups.clear();
}

/**
 * Run a command in the sandbox.
 */
async function runInSandbox(
  command: string,
  args: string[],
  options: {
    /** Where the process starts; inside workDir. */
    cwd: string;
    /** The workspace, which the profile is rooted at whatever cwd is. */
    workDir: string;
    /** Directories the step may read and never write, such as an action's code. */
    readOnlyPaths?: string[];
    env: Record<string, string>;
    proxyPort: number;
    onOutput?: (line: string, stream: 'stdout' | 'stderr') => void;
    sandboxLogFile?: string;
    collectedPids?: Set<number>;
    /** Values to redact from anything the step prints */
    secrets?: Record<string, string>;
  },
  policy?: SandboxPolicy,
  permissive?: boolean
): Promise<SandboxResult> {
  return new Promise((resolve, reject) => {
    let spawnArgs: string[];
    let spawnCommand: string;
    let usedSandbox = false;
    let profilePath = '';
    let removeProfile = () => {};

    if (process.platform === 'darwin') {
      let profile: string;

      const isDiscovery = !!permissive && !!options.sandboxLogFile;
      if (isDiscovery) {
        // Discovery mode: use special profile that logs all access
        profile = generateDiscoveryProfile({
          workDir: options.workDir,
          readOnlyPaths: options.readOnlyPaths,
          proxyPort: options.proxyPort,
          logFile: options.sandboxLogFile ?? '',
        });
      } else {
        // Enforcement mode: apply sandbox with policy restrictions
        profile = generateSandboxProfile({
          workDir: options.workDir,
          readOnlyPaths: options.readOnlyPaths,
          proxyPort: options.proxyPort,
          policy: policy || {},  // Empty policy = no network allowlist
          permissive: false,
          logFile: options.sandboxLogFile,
        });
      }

      const written = writeStepProfile(profile);
      profilePath = written.profilePath;
      removeProfile = written.remove;

      spawnCommand = '/usr/bin/sandbox-exec';
      usedSandbox = true;
      spawnArgs = ['-f', profilePath, command, ...args];
    } else {
      spawnCommand = command;
      spawnArgs = args;
    }

    // No DOCKER_HOST here. The runner points a job at the filtering socket
    // it serves; test mode does not serve one yet, and the profile keeps the
    // daemon's own socket closed, so a job under localmost test runs without
    // Docker rather than with an unfiltered daemon.
    //
    // Detached, so the step leads a process group of its own and whatever it
    // leaves running can be reaped when the job ends.
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    const proc = spawn(spawnCommand, spawnArgs, spawnOptions);
    trackStepProcessGroup(proc);
    const stderrLines: string[] = [];

    // Track process tree using kqueue-based PidTreeWatcher for discovery mode
    let pidWatcher: PidTreeWatcher | undefined;
    if (options.collectedPids && proc.pid) {
      options.collectedPids.add(proc.pid);
      pidWatcher = new PidTreeWatcher();
      pidWatcher.start(proc.pid);
    }

    const secrets = options.secrets || {};

    // Chunk boundaries are arbitrary, so both masking and line splitting have to
    // carry state across chunks; doing either per chunk leaks secrets and breaks
    // lines in half.
    const makeSink = (stream: 'stdout' | 'stderr') => {
      const masker = createSecretMasker(secrets);
      let pending = '';

      const emit = (line: string) => {
        if (!line) return;
        if (stream === 'stderr') stderrLines.push(line);
        options.onOutput?.(line, stream);
      };

      return {
        write(chunk: string) {
          pending += masker.push(chunk);
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) emit(line);
        },
        end() {
          pending += masker.flush();
          for (const line of pending.split('\n')) emit(line);
          pending = '';
        },
      };
    };

    const stdoutSink = makeSink('stdout');
    const stderrSink = makeSink('stderr');

    proc.stdout?.on('data', (data: Buffer) => stdoutSink.write(data.toString()));
    proc.stderr?.on('data', (data: Buffer) => stderrSink.write(data.toString()));

    proc.on('close', (code) => {
      removeProfile();

      // Release any output still held back for masking or an unterminated line.
      stdoutSink.end();
      stderrSink.end();

      // Stop PID watcher and collect all PIDs
      if (pidWatcher && options.collectedPids) {
        const watchedPids = pidWatcher.stop();
        for (const pid of watchedPids) {
          options.collectedPids.add(pid);
        }
      }

      // Already masked on the way in, but the error surfaces in job history
      // and notifications, so mask again rather than rely on that.
      let stderr = maskSecrets(stderrLines.slice(-10).join('\n'), secrets);

      // A sandboxed process that dies on SIGABRT with nothing on stderr has
      // almost always been denied something it needed before it could run -
      // dyld cannot even load the binary. The bare exit code says none of that.
      const abortedSilently = code === 134 && stderrLines.length === 0;
      if (abortedSilently && usedSandbox) {
        stderr =
          'The step was stopped by the sandbox before it could run. ' +
          'Its policy is probably missing a read path the process needs. ' +
          'Run "localmost test --updaterc" to discover what it wants, or ' +
          '"localmost policy init" to start from a policy that runs.';
        options.onOutput?.(stderr, 'stderr');
      }

      resolve({ exitCode: code ?? 1, stderr });
    });

    proc.on('error', (err) => {
      removeProfile();
      if (pidWatcher) {
        pidWatcher.stop();
      }
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
