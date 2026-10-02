/**
 * Step Executor
 *
 * Executes workflow steps (both `run:` and `uses:` steps) with sandbox
 * support and proper environment setup.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import { WorkflowStep, WorkflowJob, MatrixCombination } from './workflow-parser';
import {
  SandboxPolicy,
  LoopbackGrant,
  generateSandboxProfile,
  generateDiscoveryProfile,
  MACOS_BASELINE_READ_PATHS,
  ProcessMarker,
} from './sandbox-profile';
import { PidTreeWatcher } from './pid-tree-watch';
import { reapMarkedProcesses } from './sandbox-reaper';
import { parseActionRef, fetchAction, isInterceptedAction, readActionMetadata } from './action-fetcher';
import { resolveWithin } from './contained-path';
import { getAppDataDirWithoutElectron } from './paths';
import { gitSshCommand } from './job-home';

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
  /**
   * Whose caches actions/cache reaches: the checkout the run was started in,
   * and the repository and ref read from it, set before any workflow content
   * is merged in. No scope, no cache.
   */
  cacheScope?: { sourceDir: string; repository: string; ref: string };
  /** Sandbox policy to enforce */
  policy?: SandboxPolicy;
  /**
   * Loopback ports a step may reach besides the proxy's: the checkout's
   * shared network.loopback, once the user has confirmed it. Absent, only
   * the proxy.
   */
  loopback?: LoopbackGrant;
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
  return ensureStepDir(workDir, '.home');
}

/**
 * Create a directory the app hands every step, directly in the workspace.
 *
 * mkdir without recursion, so a link a step left at the name is never
 * followed to create a directory somewhere else.
 */
function ensureStepDir(workDir: string, name: string): string {
  const dir = path.join(workDir, name);
  try {
    fs.mkdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return dir;
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

/** The variables that point a step's temp files, and tools' temp caches, at `tmp`. */
function stepTempEnvironment(tmp: string): Record<string, string> {
  return {
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    xcrun_db: path.join(tmp, 'xcrun_db'),
    CLANG_MODULE_CACHE_PATH: path.join(tmp, 'clang-module-cache'),
    TMPPREFIX: path.join(tmp, 'zsh'),
  };
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
    // ssh finds its directory through the user database, not HOME, so git's
    // ssh is pointed at the step's home, which the run filled before its
    // first step (see prepareJobHome).
    GIT_SSH_COMMAND: gitSshCommand(ensureStepHome(ctx.workDir)),
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

    // Temp, in the workspace: the sandbox grants no shared temp directory, as
    // the runner grants a job none. Some tools ignore TMPDIR and keep state in
    // the per-user temp and cache directories instead, each with a variable
    // that moves it: xcrun cannot resolve a tool at all without a cache it can
    // write, clang and swiftc keep their module cache there, and zsh puts
    // here-documents under /tmp. Unix sockets are made here too, which is
    // where the profile lets a step bind them.
    ...stepTempEnvironment(ensureStepDir(ctx.workDir, '.tmp')),

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

  // 0700, not 0755: expanding ${{ secrets.X }} puts the value in this file for
  // as long as the step runs, and another account should not be able to read it.
  const scriptFile = createStepFile(ctx.workDir, '.step', '.sh', script, 0o700);
  const outputFile = createStepFile(ctx.workDir, '.github-output', '', '', 0o600);
  env.GITHUB_OUTPUT = outputFile;

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
        loopback: ctx.loopback,
        onOutput: ctx.onOutput,
        sandboxLogFile: ctx.sandboxLogFile,
        collectedPids: ctx.collectedPids,
        secrets: ctx.secrets,
      },
      ctx.policy,
      ctx.permissive
    );

    const outputs = readStepOutputs(outputFile);

    return {
      name: stepName,
      status: result.exitCode === 0 ? 'success' : 'failure',
      exitCode: result.exitCode,
      duration: 0,
      outputs,
      error: result.exitCode !== 0 && result.stderr ? result.stderr : undefined,
    };
  } finally {
    // rm, not unlink-if-exists: whatever the step left at these names is
    // removed without being followed.
    fs.rmSync(scriptFile, { force: true });
    fs.rmSync(outputFile, { force: true });
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
    const outputFile = createStepFile(ctx.workDir, '.github-output', '', '', 0o600);
    env.GITHUB_OUTPUT = outputFile;
    let result: SandboxResult;
    let outputs: Record<string, string>;
    try {
      result = await runInSandbox(
        'node',
        [mainPath],
        {
          cwd: ctx.workDir,
          workDir: ctx.workDir,
          readOnlyPaths: [actionPath],
          env,
          proxyPort: ctx.proxyPort,
          loopback: ctx.loopback,
          onOutput: ctx.onOutput,
          sandboxLogFile: ctx.sandboxLogFile,
          collectedPids: ctx.collectedPids,
          secrets: ctx.secrets,
        },
        ctx.policy,
        ctx.permissive
      );
      outputs = readStepOutputs(outputFile);
    } finally {
      fs.rmSync(outputFile, { force: true });
    }

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

  // actions/cache/save saves; actions/cache and actions/cache/restore restore
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

  // Use the local working tree. GITHUB_SHA and GITHUB_REF were read from the
  // checkout the run was started in, before any step ran. No git runs here:
  // this is the workspace, outside any sandbox, and an earlier step can have
  // left a .git whose config names a command - core.fsmonitor runs on status.
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
 * Where a repository's caches for one ref live.
 *
 * Caches were one directory for everything `localmost test` ever ran, so a
 * checkout under test could save a poisoned node_modules under a key the next
 * repository - or the same repository's main branch - restored and ran. On
 * GitHub a cache is scoped to its repository and branch; here it is scoped to
 * the checkout on disk the run was started from, and to the repository and
 * ref read from it. The repository and ref alone are claims: every checkout
 * with no remote is local/repo, one that ships its own .git names any origin
 * it likes, and the workflow's env used to override both. Where the checkout
 * sits is chosen by the user. A hash names the directory, so no two scopes
 * can share one. Undefined when the run gave no scope.
 */
function getLocalCacheDir(ctx: ExecutionContext): string | undefined {
  if (!ctx.cacheScope) return undefined;
  const { sourceDir, repository, ref } = ctx.cacheScope;
  const hash = crypto.createHash('sha256').update(JSON.stringify([sourceDir, repository, ref])).digest('hex').slice(0, 32);
  return path.join(getAppDataDirWithoutElectron(), 'workflow-cache', hash);
}

/**
 * Create a safe directory name from a cache key.
 */
function sanitizeCacheKey(key: string): string {
  // Replace unsafe characters with underscores
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

/**
 * The paths a cache step names, relative to the workspace, as tar members.
 *
 * A leading ~ is the step's HOME, which is in the workspace. Anything that
 * lands outside the workspace is dropped with a note: the cache is copied by
 * this process's own tools, and an absolute path used to have it copy the
 * user's files into the cache, or write over them on restore.
 */
function cacheMembers(pathInput: string, ctx: ExecutionContext): string[] {
  const home = path.join(ctx.workDir, '.home');
  const members: string[] = [];
  for (const raw of pathInput.split('\n').map((p) => p.trim()).filter(Boolean)) {
    const expanded = raw === '~' || raw.startsWith('~/') ? path.join(home, raw.slice(1)) : raw;
    const relative = path.relative(ctx.workDir, path.resolve(ctx.workDir, expanded));
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      ctx.onOutput?.(`  Skipped (outside the workspace): ${raw}`, 'stdout');
      continue;
    }
    members.push(`./${relative}`);
  }
  return members;
}

/**
 * Run tar under a sandbox profile rooted at the workspace.
 *
 * The workspace is the steps' to write, so the copy is made by a process the
 * kernel confines to it rather than by this one: a symlink a step left in
 * the workspace leads tar nowhere it could not already go. The archive
 * travels over a pipe, so the cache directory itself is never in the profile.
 */
function runSandboxedTar(
  args: string[],
  ctx: ExecutionContext,
  io: { stdinFile?: string; stdoutFile?: string }
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { profilePath, remove } = writeStepProfile(
      generateSandboxProfile({
        workDir: ctx.workDir,
        proxyPort: ctx.proxyPort,
        policy: { filesystem: { read: MACOS_BASELINE_READ_PATHS } },
        processMarker: stepProcessMarker(),
      })
    );
    const proc = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, '/usr/bin/tar', ...args], {
      cwd: ctx.workDir,
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
      shell: false,
      detached: true,
      stdio: [io.stdinFile ? 'pipe' : 'ignore', io.stdoutFile ? 'pipe' : 'ignore', 'pipe'],
    });
    trackStepProcessGroup(proc);

    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    const written = io.stdoutFile
      ? new Promise<void>((done, fail) => {
          const out = fs.createWriteStream(io.stdoutFile!, { flags: 'wx', mode: 0o600 });
          out.on('finish', done);
          out.on('error', fail);
          proc.stdout?.pipe(out);
        })
      : Promise.resolve();
    if (io.stdinFile && proc.stdin) {
      // Either end can go first: tar may exit before reading everything, and
      // a failed read has to end the input rather than leave tar waiting.
      const input = fs.createReadStream(io.stdinFile);
      input.on('error', () => proc.stdin?.destroy());
      proc.stdin.on('error', () => input.destroy());
      input.pipe(proc.stdin);
    }

    proc.on('error', (err) => {
      remove();
      reject(err);
    });
    proc.on('close', (code) => {
      remove();
      written.then(() => resolve({ exitCode: code ?? 1, stderr }), reject);
    });
  });
}

/**
 * Intercept actions/cache and actions/cache/restore - restore from the local cache.
 */
async function executeCacheIntercept(
  step: WorkflowStep,
  ctx: ExecutionContext,
  stepName: string
): Promise<StepResult> {
  const key = step.with?.key as string | undefined;
  const cachePath = step.with?.path as string | undefined;
  const restoreKeys = step.with?.['restore-keys'] as string | undefined;
  const miss: StepResult = { name: stepName, status: 'success', duration: 0, outputs: { 'cache-hit': 'false' } };

  if (!key || !cachePath) {
    ctx.onOutput?.('Cache: missing key or path', 'stdout');
    return miss;
  }

  ctx.onOutput?.(`Cache (local): key=${key}, path=${cachePath}`, 'stdout');

  const cacheDir = getLocalCacheDir(ctx);
  if (!cacheDir) {
    ctx.onOutput?.('Cache: no scope for this run, not restoring', 'stdout');
    return miss;
  }
  const exact = path.join(cacheDir, `${sanitizeCacheKey(key)}.tar`);
  let archive: string | undefined = fs.existsSync(exact) ? exact : undefined;

  // Restore keys match by prefix, newest first, as on GitHub.
  if (!archive && restoreKeys && fs.existsSync(cacheDir)) {
    const entries = fs.readdirSync(cacheDir)
      .filter((name) => name.endsWith('.tar'))
      .map((name) => ({ name, mtime: fs.statSync(path.join(cacheDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const prefix of restoreKeys.split('\n').map((k) => k.trim()).filter(Boolean)) {
      const match = entries.find((entry) => entry.name.startsWith(sanitizeCacheKey(prefix)));
      if (match) {
        ctx.onOutput?.(`Cache restored from key prefix: ${prefix}`, 'stdout');
        archive = path.join(cacheDir, match.name);
        break;
      }
    }
  }

  if (!archive) {
    ctx.onOutput?.('Cache miss', 'stdout');
    return miss;
  }
  if (archive === exact) ctx.onOutput?.(`Cache hit: ${key}`, 'stdout');

  try {
    const result = await runSandboxedTar(['-x', '-f', '-', '-C', ctx.workDir], ctx, { stdinFile: archive });
    if (result.exitCode !== 0) {
      ctx.onOutput?.(`Cache restore error: ${result.stderr.trim()}`, 'stderr');
      return miss;
    }
  } catch (err) {
    ctx.onOutput?.(`Cache restore error: ${(err as Error).message}`, 'stderr');
    return miss;
  }
  return { name: stepName, status: 'success', duration: 0, outputs: { 'cache-hit': archive === exact ? 'true' : 'false' } };
}

/**
 * Intercept actions/cache/save - save to the local cache.
 */
async function executeCacheSaveIntercept(
  step: WorkflowStep,
  ctx: ExecutionContext,
  stepName: string
): Promise<StepResult> {
  const key = step.with?.key as string | undefined;
  const cachePath = step.with?.path as string | undefined;
  // Cache save failure shouldn't fail the workflow
  const done: StepResult = { name: stepName, status: 'success', duration: 0, outputs: {} };

  if (!key || !cachePath) {
    ctx.onOutput?.('Cache save: missing key or path', 'stdout');
    return done;
  }

  ctx.onOutput?.(`Cache save (local): key=${key}, path=${cachePath}`, 'stdout');

  const cacheDir = getLocalCacheDir(ctx);
  if (!cacheDir) {
    ctx.onOutput?.('Cache save: no scope for this run, not saving', 'stdout');
    return done;
  }

  const members = cacheMembers(cachePath, ctx).filter((member) => {
    // Only a hint: tar runs confined to the workspace whatever is here.
    const present = fs.existsSync(path.join(ctx.workDir, member));
    if (!present) ctx.onOutput?.(`  Skipped (not found): ${member}`, 'stdout');
    return present;
  });
  if (members.length === 0) return done;

  const archive = path.join(cacheDir, `${sanitizeCacheKey(key)}.tar`);
  // Entries are immutable once saved, as on GitHub.
  if (fs.existsSync(archive)) {
    ctx.onOutput?.(`Cache already saved for key: ${key}`, 'stdout');
    return done;
  }

  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const partial = path.join(cacheDir, `.partial-${crypto.randomBytes(8).toString('hex')}`);
  try {
    const result = await runSandboxedTar(['-c', '-f', '-', '-C', ctx.workDir, '--', ...members], ctx, {
      stdoutFile: partial,
    });
    if (result.exitCode !== 0) {
      ctx.onOutput?.(`Cache save error: ${result.stderr.trim()}`, 'stderr');
      return done;
    }
    fs.renameSync(partial, archive);
    for (const member of members) ctx.onOutput?.(`  Saved: ${member}`, 'stdout');
  } catch (err) {
    ctx.onOutput?.(`Cache save error: ${(err as Error).message}`, 'stderr');
  } finally {
    fs.rmSync(partial, { force: true });
  }
  return done;
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

/** This job's process marker and the private directory holding it, once a step has needed one. */
let jobMarker: (ProcessMarker & { dir: string }) | undefined;

/**
 * The marker every profile this job spawns under carries (see
 * processMarkerRules), made the first time a step needs it.
 *
 * Two empty files with random names in a fresh private directory under the
 * app data directory, which no step can reach. Real paths, as seatbelt
 * matches those.
 */
function stepProcessMarker(): ProcessMarker {
  if (!jobMarker) {
    const base = path.join(getAppDataDirWithoutElectron(), 'test-sandbox-profiles');
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(base, 'job-')));
    const file = () => {
      const name = path.join(dir, `mark-${crypto.randomBytes(8).toString('hex')}`);
      fs.writeFileSync(name, '', { mode: 0o600, flag: 'wx' });
      return name;
    };
    jobMarker = { dir, granted: file(), withheld: file() };
  }
  return { granted: jobMarker.granted, withheld: jobMarker.withheld };
}

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
 * First by process group. A pid is never reused while it names a live
 * process group, so while the group has members its leader's pid addresses
 * exactly them. Once the leader has exited, a live process with that pid
 * means the group emptied and the pid was reused: that group is someone
 * else's, and is left alone.
 *
 * Then by sandbox, since a process can leave its group with setsid() and
 * outlive the job with its sandbox intact - able to write the workspace, and
 * to hold a loopback port a later run's tests connect to. Its sandbox is the
 * one thing it cannot leave, and every profile this job spawned carries its
 * marker.
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

  if (jobMarker) {
    const { dir, granted, withheld } = jobMarker;
    if (!reapMarkedProcesses({ granted, withheld })) {
      console.error('Warning: could not look for step processes that left their process group; some may still be running.');
    }
    // Removed either way; the next job makes its own.
    jobMarker = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    /** Loopback ports beyond the proxy's; see ExecutionContext.loopback. */
    loopback?: LoopbackGrant;
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
          processMarker: stepProcessMarker(),
        });
      } else {
        // Enforcement mode: apply sandbox with policy restrictions
        profile = generateSandboxProfile({
          workDir: options.workDir,
          readOnlyPaths: options.readOnlyPaths,
          proxyPort: options.proxyPort,
          loopback: options.loopback,
          policy: policy || {},  // Empty policy = no network allowlist
          permissive: false,
          logFile: options.sandboxLogFile,
          processMarker: stepProcessMarker(),
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
 * Create a file the app hands a step, directly in the workspace, under a name
 * no one could have guessed, and without following anything already there.
 *
 * The workspace is the step's to write, and something an earlier step left
 * running is still there. The script used to go at .step-<ms>.sh and the
 * output file at .github-output, both written with a plain writeFileSync: a
 * symlink planted at either name had this unsandboxed process write the
 * workflow's own script over any file of the user's, or truncate one. A
 * random name and O_EXCL leave nothing to plant; the workspace directory
 * itself is not the step's to replace.
 */
function createStepFile(workDir: string, prefix: string, suffix: string, content: string, mode: number): string {
  const file = path.join(workDir, `${prefix}-${crypto.randomBytes(8).toString('hex')}${suffix}`);
  fs.writeFileSync(file, content, { mode, flag: 'wx' });
  return file;
}

/**
 * Read a step's outputs back, refusing a file the step swapped for a link.
 *
 * The step can replace its output file with a symlink or a hard link to any
 * file it cannot read itself - ~/.aws/credentials is name=value lines already
 * - and this read happens outside the sandbox, with the result handed to the
 * next step as ${{ steps.<id>.outputs.* }}. Opened without following a
 * symlink or waiting on a FIFO, which would stop the run until a writer came,
 * and read only if it is a regular file with no other name.
 */
function readStepOutputs(filePath: string): Record<string, string> {
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return {};
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) return {};
    return parseGitHubOutput(fs.readFileSync(fd, 'utf-8'));
  } finally {
    fs.closeSync(fd);
  }
}

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
