/**
 * Step Executor
 *
 * Executes workflow steps (both `run:` and `uses:` steps) for `localmost
 * test`: each step runs where its StepRunner puts it - a macOS VM, from the
 * same golden image as runner jobs (src/cli/test-vm.ts) - with the
 * environment a GitHub-hosted step would see, its output masked of secrets
 * as it streams back, and its outputs read from what it wrote to
 * GITHUB_OUTPUT.
 */

import * as fs from 'fs';
import * as path from 'path';
import { WorkflowStep, WorkflowJob, MatrixCombination } from './workflow-parser';
import { parseActionRef, fetchAction, isInterceptedAction, readActionMetadata } from './action-fetcher';
import { resolveWithin } from './contained-path';

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

/** One step, as a StepRunner runs it. Paths are as the steps see them. */
export interface RunnerStep {
  /** A shell with its script, or node with an action's entry point. */
  program: 'bash' | 'sh' | 'zsh' | 'node';
  script?: string;
  entry?: string;
  /** Where the step starts: the workspace, or a directory in it. */
  cwd: string;
  env: Record<string, string>;
  /** Each line the step prints, as it prints it. */
  onLine: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface RunnerStepResult {
  exitCode: number;
  /** What the step wrote to GITHUB_OUTPUT. */
  outputs: string;
}

/**
 * Where a run's steps run. The workspace and every path a step is given are
 * the runner's, not this machine's: a step sees none of the files here
 * except what was sent in.
 */
export interface StepRunner {
  /** The workspace as steps see it: GITHUB_WORKSPACE. */
  readonly workDir: string;
  /** Sends a directory of this machine's - an action's code - in for steps to use; resolves with where they see it. */
  provide(hostDir: string): Promise<string>;
  /** Runs one step to its end. */
  run(step: RunnerStep): Promise<RunnerStepResult>;
  /** Ends whatever the job's steps left running, as GitHub's runner does at the end of a job. */
  endJob(): Promise<void>;
}

export interface ExecutionContext {
  /** The workspace as steps see it (GITHUB_WORKSPACE), in the runner. */
  workDir: string;
  /**
   * The copy of the checkout on this machine that the workspace was made
   * from, before any step ran: where a local action's metadata is read.
   */
  hostWorkDir: string;
  /** Where the steps run. */
  runner: StepRunner;
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
 * The default GITHUB_* and RUNNER_* variables the run sets. GitHub does not
 * let a workflow, job or step overwrite them, and here all three are the
 * checkout's to write: an `env:` naming GITHUB_REPOSITORY would otherwise
 * give a step, and ${{ github.repository }}, another repository's identity.
 * Other GITHUB_* names, such as GITHUB_TOKEN, stay the workflow's to set.
 */
export const RESERVED_ENV_NAMES = [
  'GITHUB_ACTIONS', 'GITHUB_WORKFLOW', 'GITHUB_RUN_ID', 'GITHUB_RUN_NUMBER', 'GITHUB_JOB', 'GITHUB_ACTION',
  'GITHUB_ACTOR', 'GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME', 'GITHUB_WORKSPACE', 'GITHUB_SHA', 'GITHUB_REF',
  'GITHUB_HEAD_REF', 'GITHUB_BASE_REF', 'GITHUB_SERVER_URL', 'GITHUB_API_URL', 'GITHUB_GRAPHQL_URL',
  'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_STEP_SUMMARY',
  'RUNNER_NAME', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_TEMP', 'RUNNER_TOOL_CACHE',
] as const;
type ReservedEnvName = (typeof RESERVED_ENV_NAMES)[number];
const RESERVED_ENV = new Set<string>(RESERVED_ENV_NAMES);

/** `env` without the names the run reserves (RESERVED_ENV_NAMES): a workflow's or job's own `env:`. */
export function withoutReservedEnv(env: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(env || {}).filter(([name]) => !RESERVED_ENV.has(name)));
}

/**
 * Build the full environment for step execution.
 *
 * The runner adds its own HOME, PATH, user, shell and temp, which a step's
 * environment cannot replace: the guest's, not this machine's.
 *
 * The reserved variables are read from the run's own values in
 * ctx.workflowEnv and ctx.jobEnv (which hold no workflow- or job-declared
 * value for them) and set again after every merge, so no `env:` replaces one.
 */
export function buildStepEnvironment(
  step: WorkflowStep,
  ctx: ExecutionContext,
  job: WorkflowJob
): Record<string, string> {
  const reserved: Record<ReservedEnvName, string> = {
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
    GITHUB_ENV: path.posix.join(ctx.workDir, '.github-env'),
    GITHUB_PATH: path.posix.join(ctx.workDir, '.github-path'),
    GITHUB_STEP_SUMMARY: path.posix.join(ctx.workDir, '.github-step-summary'),

    // Runner information
    RUNNER_NAME: 'localmost',
    RUNNER_OS: 'macOS',
    RUNNER_ARCH: 'ARM64',
    // Per run, in the workspace, which the run makes before its first step.
    RUNNER_TEMP: path.posix.join(ctx.workDir, RUNNER_TEMP_DIR),
    RUNNER_TOOL_CACHE: path.posix.join(ctx.workDir, RUNNER_TOOL_CACHE_DIR),
  };

  // Add job defaults if present
  if (job.defaults?.run?.['working-directory']) {
    reserved.GITHUB_WORKSPACE = path.posix.join(ctx.workDir, job.defaults.run['working-directory']);
  }

  const env: Record<string, string> = {
    TERM: process.env.TERM || 'xterm-256color',
    LANG: process.env.LANG || 'en_US.UTF-8',
    ...reserved,
    // ImageOS for setup-* actions
    ImageOS: 'macos14',
  };

  // Add workflow-level and job-level env
  Object.assign(env, ctx.workflowEnv, ctx.jobEnv, reserved);

  // Add step-level env
  if (step.env) {
    Object.assign(env, expandEnvValues(step.env, env, ctx), reserved);
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

/** The workspace directories RUNNER_TEMP and RUNNER_TOOL_CACHE name, made before the first step. */
export const RUNNER_TEMP_DIR = '.runner-temp';
export const RUNNER_TOOL_CACHE_DIR = '.runner-tool-cache';

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

/** The shells a `run:` step may name, as the runner's programs. */
const SHELLS: Record<string, RunnerStep['program']> = { bash: 'bash', sh: 'sh', zsh: 'zsh' };

/**
 * `target` inside the workspace as steps see it, or an error naming `what`.
 * Lexical: the path is the runner's, and a link in it leads only where the
 * step could go anyway.
 */
function withinWorkspace(ctx: ExecutionContext, target: string, what: string): string {
  const resolved = path.posix.resolve(ctx.workDir, target);
  if (resolved !== ctx.workDir && !resolved.startsWith(`${ctx.workDir}/`)) {
    throw new Error(`${what} is outside the workspace: ${target}`);
  }
  return resolved;
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
  const program = Object.hasOwn(SHELLS, shell) ? SHELLS[shell] : undefined;
  if (!program) {
    throw new Error(`shell: ${shell} is not available in the macOS VM; localmost test runs bash, sh and zsh`);
  }
  // Relative to the workspace, as on GitHub, and never outside it.
  const namedDir = step['working-directory'] || job.defaults?.run?.['working-directory'];
  const cwd = namedDir ? withinWorkspace(ctx, namedDir, 'working-directory') : ctx.workDir;

  // Expand expressions in the script
  const script = expandExpression(step.run!, env, ctx);

  const result = await runOnRunner(ctx, { program, script, cwd, env });
  return {
    name: stepName,
    status: result.exitCode === 0 ? 'success' : 'failure',
    exitCode: result.exitCode,
    duration: 0,
    outputs: result.outputs,
    error: result.exitCode !== 0 && result.stderr ? result.stderr : undefined,
  };
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

  return await executeActionFromPath(cached.localPath, () => ctx.runner.provide(cached.localPath), step, ctx, job, stepName);
}

/**
 * Execute a local action (./path/to/action).
 *
 * Its action.yml is read from this machine's copy of the checkout, which
 * is what the workspace was made from; the step runs it from the workspace.
 */
async function executeLocalAction(
  step: WorkflowStep,
  ctx: ExecutionContext,
  job: WorkflowJob,
  stepName: string
): Promise<StepResult> {
  const hostPath = resolveWithin(ctx.hostWorkDir, step.uses!, 'Local action');
  const relative = path.relative(fs.realpathSync(ctx.hostWorkDir), hostPath).split(path.sep).join('/');
  return await executeActionFromPath(hostPath, async () => path.posix.join(ctx.workDir, relative), step, ctx, job, stepName);
}

/**
 * Execute an action from a local path: `hostPath` holds its code on this
 * machine, and `guestPath` says where steps see it, sending it in if need be.
 */
async function executeActionFromPath(
  hostPath: string,
  guestPath: () => Promise<string>,
  step: WorkflowStep,
  ctx: ExecutionContext,
  job: WorkflowJob,
  stepName: string
): Promise<StepResult> {
  const metadata = readActionMetadata(hostPath);
  if (!metadata) {
    throw new Error(`No action.yml found in ${hostPath}`);
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
    // directory, with the runner's own node.
    const mainPath = resolveWithin(hostPath, main, 'Action entry point', 'the action');
    const relative = path.relative(fs.realpathSync(hostPath), mainPath).split(path.sep).join('/');
    const entry = path.posix.join(await guestPath(), relative);
    const result = await runOnRunner(ctx, { program: 'node', entry, cwd: ctx.workDir, env });

    return {
      name: stepName,
      status: result.exitCode === 0 ? 'success' : 'failure',
      exitCode: result.exitCode,
      duration: 0,
      outputs: result.outputs,
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

  // actions/cache/save saves; actions/cache and actions/cache/restore restore,
  // neither of which the macOS VM keeps yet
  if (uses.startsWith('actions/cache/save@')) {
    return executeCacheSaveIntercept(step, ctx, stepName);
  }
  if (uses.startsWith('actions/cache')) {
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

  // Use the local working tree: the workspace is a copy of it, sent into the
  // macOS VM before the first step. GITHUB_SHA and GITHUB_REF were read from
  // the checkout the run was started in, before any step ran.
  ctx.onOutput?.('Using local working tree (checkout intercepted)', 'stdout');

  // Submodules come with the working tree: the workspace is a copy of the
  // checkout, initialized submodules included.
  if (step.with?.submodules === 'true' || step.with?.submodules === true) {
    ctx.onOutput?.('Submodules: using those already checked out in the working tree', 'stdout');
  }

  return {
    name: stepName,
    status: 'success',
    duration: 0,
    outputs: {},
  };
}

/**
 * Intercept actions/cache and actions/cache/restore: always a miss. Caches
 * are not kept between runs in the macOS VM yet, and a miss is what a step
 * must cope with anyway.
 */
function executeCacheIntercept(step: WorkflowStep, ctx: ExecutionContext, stepName: string): StepResult {
  ctx.onOutput?.(`Cache: not restored (${String(step.with?.key ?? 'no key')}) - localmost test keeps no caches in the macOS VM yet`, 'stdout');
  return { name: stepName, status: 'success', duration: 0, outputs: { 'cache-hit': 'false' } };
}

/** Intercept actions/cache/save: nothing is saved, as nothing is restored. */
function executeCacheSaveIntercept(step: WorkflowStep, ctx: ExecutionContext, stepName: string): StepResult {
  ctx.onOutput?.(`Cache save: skipped (${String(step.with?.key ?? 'no key')}) - localmost test keeps no caches in the macOS VM yet`, 'stdout');
  return { name: stepName, status: 'success', duration: 0, outputs: {} };
}

/**
 * Intercept actions/upload-artifact - stubbed.
 */
function executeUploadArtifactIntercept(
  step: WorkflowStep,
  ctx: ExecutionContext,
  stepName: string
): StepResult {
  const name = step.with?.name as string | undefined || 'artifact';
  const artifactPath = step.with?.path as string | undefined;

  ctx.onOutput?.(`Artifact stubbed: ${name} (would upload ${artifactPath})`, 'stdout');

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
// Running a Step
// =============================================================================

/**
 * Run one step on the context's runner: its output masked of secrets and
 * passed on line by line, its last stderr lines kept for the error, and its
 * GITHUB_OUTPUT parsed.
 */
async function runOnRunner(
  ctx: ExecutionContext,
  step: Omit<RunnerStep, 'onLine'>
): Promise<{ exitCode: number; outputs: Record<string, string>; stderr: string }> {
  const secrets = ctx.secrets || {};
  const stderrLines: string[] = [];

  // Lines come whole from the runner, but a multi-line secret spans them,
  // so masking carries its state across lines as it would across chunks.
  const makeSink = (stream: 'stdout' | 'stderr') => {
    const masker = createSecretMasker(secrets);
    let pending = '';
    const emit = (line: string) => {
      if (!line) return;
      if (stream === 'stderr') stderrLines.push(line);
      ctx.onOutput?.(line, stream);
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
  const sinks = { stdout: makeSink('stdout'), stderr: makeSink('stderr') };

  const result = await ctx.runner.run({ ...step, onLine: (line, stream) => sinks[stream].write(`${line}\n`) });
  sinks.stdout.end();
  sinks.stderr.end();

  // Already masked on the way in, but the error surfaces in the summary, so
  // mask again rather than rely on that.
  const stderr = maskSecrets(stderrLines.slice(-10).join('\n'), secrets);
  return { exitCode: result.exitCode, outputs: parseGitHubOutput(result.outputs), stderr };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Parse the GITHUB_OUTPUT file format.
 * Format: name=value or name<<EOF\nvalue\nEOF
 */
function parseGitHubOutput(content: string): Record<string, string> {
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
