/**
 * CLI Test Command
 *
 * Runs GitHub Actions workflows locally before pushing, each job's steps
 * in a fresh macOS VM from localmost's golden image (see test-vm.ts).
 *
 * Usage:
 *   localmost test                              # Run default workflow
 *   localmost test .github/workflows/build.yml  # Run specific workflow
 *   localmost test build.yml --job build-ios    # Run specific job
 *   localmost test --updaterc                   # Discovery mode
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  parseWorkflowFile,
  findDefaultWorkflow,
  findWorkflowFiles,
  generateMatrixCombinations,
  parseMatrixSpec,
  findMatchingCombination,
  extractSecretReferences,
  ParsedWorkflow,
  WorkflowJob,
  MatrixCombination,
  isReusableWorkflowJob,
  parseReusableWorkflow,
  resolveReusableWorkflowPath,
  resolveReusableWorkflowInputs,
  ReusableWorkflow,
} from '../shared/workflow-parser';
import {
  executeStep,
  ExecutionContext,
  RUNNER_TEMP_DIR,
  RUNNER_TOOL_CACHE_DIR,
  StepResult,
  StepRunner,
  StepStatus,
} from '../shared/step-executor';
import { dryRunRunner, openVmStepRunner } from './test-vm';
import {
  findLocalmostrc,
  LOCALMOSTRC_FILENAME,
  parseLocalmostrc,
  getEffectivePolicy,
  hostPatternProblem,
  LocalmostrcConfig,
  serializeLocalmostrc,
  unreadLocalmostrcNote,
  writeLocalmostrc,
  LOCALMOSTRC_VERSION,
} from '../shared/localmostrc';
import type { PolicyRules } from '../shared/policy-types';
import { DockerPolicy, diffDockerPolicy, mergeDockerPolicy, parseDockerPolicyHint } from '../shared/docker-policy';
import { DiscoveryProxy } from '../shared/discovery-proxy';
import { createWorkspace, cleanupWorkspaces, getGitInfo, getRepositoryFromDir } from '../shared/workspace';
import { getAppDataDirWithoutElectron } from '../shared/paths';
import {
  detectLocalEnvironment,
  compareEnvironments,
  formatEnvironmentDiff,
  formatEnvironmentInfo,
} from '../shared/environment';

// =============================================================================
// Types
// =============================================================================

export interface TestOptions {
  /** Workflow file to run (default: auto-detect) */
  workflow?: string;
  /** Specific job to run (default: all jobs) */
  job?: string;
  /** Run in discovery mode to generate .localmostrc */
  updaterc?: boolean;
  /** Answer yes to every confirmation: grants beyond the workspace, running discovery, and writing what it found */
  assumeYes?: boolean;
  /** Path to a KEY=value file holding secret values */
  secretFile?: string;
  /** Run full matrix (default: first combination only) */
  fullMatrix?: boolean;
  /** Specific matrix combination */
  matrix?: string;
  /** Show dry run without executing */
  dryRun?: boolean;
  /** Verbose output */
  verbose?: boolean;
  /** Use staged changes only */
  staged?: boolean;
  /** Skip .gitignore (include all files) */
  noIgnore?: boolean;
  /** Show environment diff after run */
  showEnv?: boolean;
  /** Secret handling mode */
  secretMode?: 'stub' | 'prompt' | 'abort';
}

export interface TestResult {
  success: boolean;
  workflow: string;
  jobResults: JobResult[];
  duration: number;
  environmentDiffs?: string;
}

export interface JobResult {
  jobId: string;
  jobName: string;
  matrix?: MatrixCombination;
  steps: StepResult[];
  status: 'success' | 'failure' | 'skipped';
  duration: number;
  /** Outputs from this job (for use by dependent jobs) */
  outputs?: Record<string, string>;
}

/** Tracks outputs from completed jobs for dependency resolution */
interface JobOutputs {
  [jobId: string]: Record<string, string>;
}

// =============================================================================
// Output Formatting
// =============================================================================

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function success(text: string): string {
  return `${colors.green}\u2713${colors.reset} ${text}`;
}

function failure(text: string): string {
  return `${colors.red}\u2717${colors.reset} ${text}`;
}

function pending(text: string): string {
  return `${colors.dim}\u25CB${colors.reset} ${text}`;
}

function running(text: string): string {
  return `${colors.blue}\u25CF${colors.reset} ${text}`;
}

function skipped(text: string): string {
  return `${colors.yellow}-${colors.reset} ${text}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes}m ${secs}s`;
}

function formatStepStatus(status: StepStatus, name: string, duration?: number): string {
  const durationStr = duration ? ` (${formatDuration(duration)})` : '';
  switch (status) {
    case 'success':
      return success(`${name}${durationStr}`);
    case 'failure':
      return failure(`${name}${durationStr}`);
    case 'skipped':
      return skipped(`${name} (skipped)`);
    case 'running':
      return running(`${name}...`);
    case 'pending':
    default:
      return pending(name);
  }
}

// =============================================================================
// Main Test Function
// =============================================================================

/** What runTest runs the steps on: a macOS VM from the app, unless a test passes its own. */
export interface TestDeps {
  openRunner?: (opts: {
    proxyPort: number;
    hostWorkDir: string;
    onNote: (message: string) => void;
  }) => Promise<StepRunner & { close(): void }>;
}

/**
 * Run the test command.
 */
export async function runTest(options: TestOptions = {}, deps: TestDeps = {}): Promise<TestResult> {
  const startTime = Date.now();
  const cwd = process.cwd();

  // Find or validate workflow file
  const workflowPath = resolveWorkflowPath(options.workflow, cwd);
  console.log(`${colors.bold}Running workflow:${colors.reset} ${path.relative(cwd, workflowPath)}`);
  console.log();

  // Parse workflow
  const workflow = parseWorkflowFile(workflowPath);

  // Get repository identifier
  const repository = getRepositoryFromDir(cwd) || 'local/repo';

  // Load .localmostrc if present
  const localmostrcPath = findLocalmostrc(cwd);
  let config: LocalmostrcConfig | undefined;
  let policy: PolicyRules | undefined;

  if (localmostrcPath) {
    console.log(`Using policy: ${path.relative(cwd, localmostrcPath)}`);
    const result = parseLocalmostrc(localmostrcPath);
    if (result.success && result.config) {
      config = result.config;
      policy = getEffectivePolicy(config, workflow.name);
      for (const warning of result.warnings) console.log(`${colors.yellow}Warning:${colors.reset} ${warning}`);
    } else {
      console.log(`${colors.yellow}Warning:${colors.reset} Invalid .localmostrc: ${result.errors[0]?.message}`);
    }
  } else {
    const unread = unreadLocalmostrcNote(cwd);
    if (unread) console.log(`${colors.yellow}Warning:${colors.reset} ${unread}`);
    if (!options.updaterc) {
      console.log(`${colors.yellow}No .localmostrc found.${colors.reset} Run with --updaterc to generate.`);
      console.log('Running in strict mode (no network access allowed).');
      // policy stays undefined = empty allowlist
    }
  }
  console.log();

  // The checkout is as untrusted as its code: nothing it grants itself
  // applies until the user has seen it. Discovery applies no policy, and is
  // asked about on its own terms. A dry run runs nothing.
  if (!options.dryRun) {
    const confirm = { assumeYes: !!options.assumeYes, isTTY: !!process.stdin.isTTY };
    const confirmed = options.updaterc
      ? await confirmDiscovery(confirm)
      : await confirmCheckoutGrants(cwd, grantsBeyondWorkspace(policy), confirm);
    if (!confirmed) {
      throw new Error(
        'Not running: confirm on a terminal, or pass --yes to run this checkout with what it asks for.'
      );
    }
  }

  // What the policy declares that the macOS VM does not give a step yet,
  // said before anything runs rather than found out from a failing step.
  if (!options.updaterc) {
    for (const note of unprovidedGrants(policy)) console.log(`${colors.yellow}Note:${colors.reset} ${note}`);
  }

  // Handle secrets
  const secretNames = extractSecretReferences(workflow.workflow);
  let secrets: Record<string, string> = {};

  if (secretNames.length > 0) {
    console.log(`Secrets required: ${secretNames.join(', ')}`);
    secrets = await resolveSecrets(repository, secretNames, options.secretMode || 'stub', options.secretFile);
    console.log();
  }

  // Build network allowlist for the proxy
  // - Discovery mode (--updaterc): no allowlist = allow everything
  // - Enforcement mode: use policy allowlist or empty array (strict mode)
  const networkAllowlist = options.updaterc
    ? undefined  // Discovery mode: allow all traffic through
    : (policy?.network?.allow || []);  // Enforcement mode: use policy or empty

  // The run's proxy: the guest has no network device, so its relay to this
  // port is a step's only way out. Enforcement reads the policy as the
  // runner's proxy does: the deny list first, then the allow list on each
  // scheme's port. Discovery applies none, and records every host.
  const discoveryProxy = new DiscoveryProxy({
    allowlist: networkAllowlist,
    denylist: options.updaterc ? undefined : policy?.network?.deny,
    onAccess: (host, port, allowed) => {
      if (options.verbose) {
        const status = allowed ? colors.dim : colors.red;
        const action = allowed ? '' : ' (BLOCKED)';
        console.log(`  ${status}[network] ${host}:${port}${action}${colors.reset}`);
      }
    },
  });
  const proxyPort = await discoveryProxy.start();

  let runner: (StepRunner & { close(): void }) | undefined;
  const removeInterruptHandlers = installInterruptHandlers(() => runner?.close());

  // Everything after the proxy starts runs inside try/finally: a throw in
  // workspace setup, the VM's start, parsing or job execution would
  // otherwise leave the proxy listening and the VM running.
  try {
  if (options.updaterc) {
    console.log(`Discovery proxy listening on port ${proxyPort}`);
    console.log();
  }

  // Create workspace
  console.log('Creating workspace...');
  const workspace = await createWorkspace({
    sourceDir: cwd,
    respectGitignore: !options.noIgnore,
    stagedOnly: options.staged,
  });
  // RUNNER_TEMP and RUNNER_TOOL_CACHE, there before the first step as a
  // runner makes them. A plain mkdir: the workspace copy is this run's own.
  fs.mkdirSync(path.join(workspace.path, RUNNER_TEMP_DIR));
  fs.mkdirSync(path.join(workspace.path, RUNNER_TOOL_CACHE_DIR));
  console.log(`Workspace: ${workspace.path}`);
  console.log();

  // Get git info for GITHUB_SHA and GITHUB_REF
  const gitInfo = getGitInfo(cwd);

  // Build proxy environment variables
  const proxyUrl = discoveryProxy.getProxyUrl();
  const proxyEnv = buildProxyEnv(proxyUrl);

  // A fresh macOS VM for the run, with the workspace sent into it. None for
  // a dry run, which runs nothing.
  let active: StepRunner & { close(): void };
  if (options.dryRun) {
    active = dryRunRunner();
  } else {
    console.log('Starting a macOS VM...');
    const open = deps.openRunner ?? openVmStepRunner;
    active = await open({
      proxyPort,
      hostWorkDir: workspace.path,
      onNote: (message) => console.log(`  ${colors.dim}${message}${colors.reset}`),
    });
    console.log(`macOS VM ready; workspace in it at ${active.workDir}`);
    console.log();
  }
  runner = active;

  // Build execution context
  const context: ExecutionContext = {
    workDir: active.workDir,
    hostWorkDir: workspace.path,
    runner: active,
    workflowEnv: buildWorkflowEnv(
      workflow.workflow.env,
      {
        GITHUB_WORKFLOW: workflow.name,
        GITHUB_REPOSITORY: repository,
        GITHUB_SHA: gitInfo?.sha || '',
        GITHUB_REF: gitInfo?.ref || '',
      },
      proxyEnv
    ),
    jobEnv: {},
    matrix: {},
    secrets,
    stepOutputs: {},
    onOutput: (line, stream) => {
      if (options.verbose) {
        const prefix = stream === 'stderr' ? colors.red : '';
        console.log(`    ${prefix}${line}${colors.reset}`);
      }
    },
    onStatus: (step, status) => {
      if (options.verbose) {
        console.log(`  ${formatStepStatus(status, step)}`);
      }
    },
  };

  // Determine which jobs to run
  const jobsToRun = options.job
    ? [options.job]
    : workflow.jobOrder;

  // Validate job exists
  for (const jobId of jobsToRun) {
    if (!workflow.workflow.jobs[jobId]) {
      throw new Error(`Job not found: ${jobId}`);
    }
  }

  // Run jobs
  const jobResults: JobResult[] = [];
  const jobOutputs: JobOutputs = {};

  for (const jobId of jobsToRun) {
    const job = workflow.workflow.jobs[jobId];
    const jobName = job.name || jobId;

    // Check if this is a reusable workflow call
    if (isReusableWorkflowJob(job)) {
      console.log(`${colors.bold}▶ ${jobName}${colors.reset} ${colors.dim}(reusable workflow)${colors.reset}`);

      const reusableResult = await runReusableWorkflowJob(
        jobId,
        job,
        workflowPath,
        { ...context, jobEnv: { ...context.jobEnv, GITHUB_JOB: jobId } },
        jobOutputs,
        options
      );

      jobResults.push(reusableResult);

      // Store outputs for dependent jobs
      if (reusableResult.outputs) {
        jobOutputs[jobId] = reusableResult.outputs;
      }

      console.log();
      continue;
    }

    // Regular job - determine matrix combinations
    const combinations = generateMatrixCombinations(job.strategy);
    let combinationsToRun: MatrixCombination[];

    if (options.fullMatrix) {
      combinationsToRun = combinations;
    } else if (options.matrix) {
      const spec = parseMatrixSpec(options.matrix);
      const match = findMatchingCombination(combinations, spec);
      if (!match) {
        throw new Error(`No matching matrix combination for: ${options.matrix}`);
      }
      combinationsToRun = [match];
    } else {
      // Just run first combination
      combinationsToRun = [combinations[0]];
    }

    // Run each matrix combination
    for (const matrix of combinationsToRun) {
      const matrixSuffix = Object.keys(matrix).length > 0
        ? ` (${Object.entries(matrix).map(([k, v]) => `${k}=${v}`).join(', ')})`
        : '';

      console.log(`${colors.bold}▶ ${jobName}${matrixSuffix}${colors.reset}`);

      const jobResult = await runJob(
        jobId,
        job,
        matrix,
        { ...context, matrix, jobEnv: { ...context.jobEnv, GITHUB_JOB: jobId, ...(job.env || {}) } },
        jobOutputs,
        options
      );

      jobResults.push(jobResult);

      // Store outputs for dependent jobs
      if (jobResult.outputs) {
        jobOutputs[jobId] = jobResult.outputs;
      }

      console.log();
    }
  }

  // Cleanup old workspaces
  await cleanupWorkspaces({ maxAgeHours: 24, maxCount: 10 });

  // Calculate overall result
  const duration = Date.now() - startTime;
  const allSucceeded = jobResults.every((j) => j.status === 'success');

  // Show environment diff if requested
  let environmentDiffs: string | undefined;
  if (options.showEnv) {
    console.log();
    const localEnv = detectLocalEnvironment();
    console.log(formatEnvironmentInfo(localEnv));
    console.log();

    // Compare to first non-reusable job's runs-on
    let runsOn: string | undefined;
    for (const jobId of jobsToRun) {
      const job = workflow.workflow.jobs[jobId];
      if (job['runs-on']) {
        runsOn = Array.isArray(job['runs-on']) ? job['runs-on'][0] : job['runs-on'];
        break;
      }
    }
    if (runsOn) {
      const diffs = compareEnvironments(localEnv, runsOn);
      environmentDiffs = formatEnvironmentDiff(diffs);
      console.log(environmentDiffs);
    } else {
      console.log('  (No runs-on to compare - all jobs are reusable workflows)');
    }
  }

  // Show summary
  console.log(colors.bold + 'Summary:' + colors.reset);
  console.log(`  Duration: ${formatDuration(duration)}`);
  console.log(`  Jobs: ${jobResults.filter((j) => j.status === 'success').length}/${jobResults.length} passed`);

  // Show network access summary (only in enforcement mode, not updaterc)
  if (!options.updaterc) {
    const accessStats = discoveryProxy.getAccessStats();
    if (accessStats.allowed.length > 0 || accessStats.blocked.length > 0) {
      console.log();
      console.log(colors.bold + 'Network Access:' + colors.reset);
      if (accessStats.allowed.length > 0) {
        console.log(`  ${colors.green}Allowed:${colors.reset} ${accessStats.allowed.join(', ')}`);
      }
      if (accessStats.blocked.length > 0) {
        console.log(`  ${colors.red}Blocked:${colors.reset} ${accessStats.blocked.join(', ')}`);
      }
    }
  }

  if (allSucceeded) {
    console.log(`\n${colors.green}${colors.bold}✓ Workflow passed${colors.reset}`);
  } else {
    console.log(`\n${colors.red}${colors.bold}✗ Workflow failed${colors.reset}`);

  }

  // Handle --updaterc (only write if workflow succeeded)
  if (options.updaterc) {
    const discoveredHosts = discoveryProxy.getAccessedHosts();

    if (allSucceeded) {
      await handleUpdateRc(cwd, workflow, { hosts: discoveredHosts }, !!options.assumeYes);
    } else {
      console.log();
      console.log(`${colors.yellow}Skipping .localmostrc generation - workflow failed.${colors.reset}`);
      console.log('Fix the workflow issues first, then run --updaterc again.');
      if (discoveredHosts.length > 0) {
        console.log();
        console.log(`${colors.dim}Hosts discovered so far: ${discoveredHosts.join(', ')}${colors.reset}`);
      }
    }
  }

  return {
    success: allSucceeded,
    workflow: workflow.name,
    jobResults,
    duration,
    environmentDiffs,
  };
  } finally {
    removeInterruptHandlers();
    runner?.close();
    await discoveryProxy.stop();
  }
}

/**
 * What a policy declares that a step in the macOS VM is not given yet, one
 * sentence each: filesystem grants, which wait for VM shares, and Docker,
 * which waits for its relay into the guest.
 */
export function unprovidedGrants(policy: PolicyRules | undefined): string[] {
  const notes: string[] = [];
  const grants = [
    ...(policy?.filesystem?.read ?? []).map((p) => `read ${p}`),
    ...(policy?.filesystem?.write ?? []).map((p) => `write ${p}`),
  ];
  if (grants.length > 0) {
    notes.push(`Filesystem grants are not provided in the macOS VM yet; this run goes without: ${grants.join(', ')}`);
  }
  if (policy?.docker && Object.keys(policy.docker).length > 0) {
    notes.push('Docker is not available in the macOS VM yet; steps that need it will fail');
  }
  return notes;
}

/** The signals that end a run early, and the exit status each ends it with. */
const INTERRUPT_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
  // The terminal closing, or an SSH session dropping.
  SIGHUP: 129,
};

/**
 * End the run - the agent connection, which kills the steps, and the VM -
 * then exit, when the run is interrupted. Returns a function that removes
 * the handlers.
 *
 * The steps run in the macOS VM, which the terminal's signals never reach;
 * without these, dying of one would leave the VM running its steps until
 * the app noticed the connection gone.
 */
export function installInterruptHandlers(reap: () => void): () => void {
  const onInterrupt = (signal: NodeJS.Signals) => {
    reap();
    process.exit(INTERRUPT_EXIT_CODES[signal] ?? 1);
  };
  const signals = Object.keys(INTERRUPT_EXIT_CODES) as NodeJS.Signals[];
  for (const signal of signals) process.once(signal, onInterrupt);
  return () => {
    for (const signal of signals) process.removeListener(signal, onInterrupt);
  };
}

/**
 * The variables that send a step's traffic through the run's proxy.
 *
 * Loopback is exempt: in the macOS VM it is the guest's own, where a step
 * reaches a server another step started, and the proxy refuses loopback
 * outright - through it, a step would reach this Mac's. Git is told to send
 * the proxy's credentials up front: otherwise it waits for a 407 challenge
 * the proxy answers by closing the connection, and the fetch aborts.
 */
export function buildProxyEnv(proxyUrl: string): Record<string, string> {
  const noProxy = 'localhost,127.0.0.1,::1';
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    GIT_HTTP_PROXY_AUTHMETHOD: 'basic',
  };
}

/**
 * A run's workflow-level environment: what the workflow declares, then the
 * GITHUB_* defaults over it, then what the run itself needs.
 *
 * GitHub does not let a workflow overwrite its default variables, and here
 * the workflow is the checkout's to write; spreading its env last let it
 * claim another repository and ref.
 */
export function buildWorkflowEnv(
  declared: Record<string, string> | undefined,
  defaults: Record<string, string>,
  runEnv: Record<string, string>
): Record<string, string> {
  return { ...(declared || {}), ...defaults, ...runEnv };
}

// =============================================================================
// Job Execution
// =============================================================================

/**
 * Run a single job.
 */
async function runJob(
  jobId: string,
  job: WorkflowJob,
  matrix: MatrixCombination,
  context: ExecutionContext,
  jobOutputs: JobOutputs,
  options: TestOptions
): Promise<JobResult> {
  const startTime = Date.now();
  const stepResults: StepResult[] = [];
  let jobStatus: 'success' | 'failure' | 'skipped' = 'success';

  // Create context with job outputs available for expression substitution
  const jobContext = {
    ...context,
    needs: jobOutputs,
  };

  // Whatever the steps left running ends with the job, as on GitHub.
  try {
    for (const step of job.steps!) {
      if (options.dryRun) {
        const stepName = step.name || step.id || (step.uses ? `Run ${step.uses}` : 'Run script');
        console.log(`  ${pending(stepName)} (dry run)`);
        continue;
      }

      const result = await executeStep(step, jobContext, job);
      stepResults.push(result);

      // Print step result
      if (!options.verbose) {
        console.log(`  ${formatStepStatus(result.status, result.name, result.duration)}`);
      }

      // Handle failure
      if (result.status === 'failure') {
        jobStatus = 'failure';
        if (result.error) {
          console.log(`    ${colors.red}Error: ${result.error}${colors.reset}`);
        } else if (result.exitCode !== undefined && result.exitCode !== 0) {
          console.log(`    ${colors.red}Exit code: ${result.exitCode}${colors.reset}`);
        } else {
          console.log(`    ${colors.red}Step failed${colors.reset}`);
        }
        // Stop on first failure (unless continue-on-error)
        if (!step['continue-on-error']) {
          break;
        }
      }
    }
  } finally {
    await endJob(context);
  }

  // Extract job outputs from step outputs
  const outputs = extractJobOutputs(job, context.stepOutputs);

  return {
    jobId,
    jobName: job.name || jobId,
    matrix: Object.keys(matrix).length > 0 ? matrix : undefined,
    steps: stepResults,
    status: jobStatus,
    duration: Date.now() - startTime,
    outputs,
  };
}

/**
 * Run a reusable workflow job.
 */
async function runReusableWorkflowJob(
  jobId: string,
  job: WorkflowJob,
  callerWorkflowPath: string,
  context: ExecutionContext,
  jobOutputs: JobOutputs,
  options: TestOptions
): Promise<JobResult> {
  const startTime = Date.now();

  // Resolve the workflow path
  const workflowPath = resolveReusableWorkflowPath(job.uses!, callerWorkflowPath);
  if (!workflowPath) {
    console.log(`  ${colors.yellow}Skipping: Remote reusable workflows not supported${colors.reset}`);
    console.log(`  ${colors.dim}uses: ${job.uses}${colors.reset}`);
    return {
      jobId,
      jobName: job.name || jobId,
      steps: [],
      status: 'skipped',
      duration: Date.now() - startTime,
    };
  }

  // Load and parse the reusable workflow
  let reusableWorkflow: ReusableWorkflow;
  try {
    reusableWorkflow = parseReusableWorkflow(workflowPath);
    console.log(`  ${colors.dim}Loading: ${path.basename(workflowPath)}${colors.reset}`);
  } catch (err) {
    console.log(`  ${colors.red}Error loading workflow: ${(err as Error).message}${colors.reset}`);
    return {
      jobId,
      jobName: job.name || jobId,
      steps: [],
      status: 'failure',
      duration: Date.now() - startTime,
    };
  }

  // Resolve inputs
  const inputs = resolveReusableWorkflowInputs(job.with, reusableWorkflow.inputs);
  if (Object.keys(inputs).length > 0) {
    console.log(`  ${colors.dim}Inputs: ${Object.entries(inputs).map(([k, v]) => `${k}=${v}`).join(', ')}${colors.reset}`);
  }

  // Run all jobs in the called workflow
  const allStepResults: StepResult[] = [];
  let overallStatus: 'success' | 'failure' | 'skipped' = 'success';
  const calledJobOutputs: JobOutputs = {};

  for (const calledJobId of reusableWorkflow.jobOrder) {
    const calledJob = reusableWorkflow.workflow.jobs[calledJobId];

    // Skip reusable workflow jobs within reusable workflows (nested not supported yet)
    if (isReusableWorkflowJob(calledJob)) {
      console.log(`  ${colors.yellow}Skipping nested reusable workflow: ${calledJobId}${colors.reset}`);
      continue;
    }

    const calledJobName = calledJob.name || calledJobId;
    console.log(`  ${colors.cyan}▸ ${calledJobName}${colors.reset}`);

    // Create context with inputs available
    const calledContext: ExecutionContext = {
      ...context,
      workflowEnv: {
        ...context.workflowEnv,
        ...(reusableWorkflow.workflow.env || {}),
      },
      jobEnv: {
        ...context.jobEnv,
        GITHUB_JOB: calledJobId,
        ...(calledJob.env || {}),
      },
      // Make inputs available as inputs.* context
      inputs,
      stepOutputs: {},
      needs: { ...jobOutputs, ...calledJobOutputs },
    };

    // Run steps in the called job, ending what they leave running with it
    try {
      for (const step of calledJob.steps!) {
        if (options.dryRun) {
          const stepName = step.name || step.id || (step.uses ? `Run ${step.uses}` : 'Run script');
          console.log(`    ${pending(stepName)} (dry run)`);
          continue;
        }

        const result = await executeStep(step, calledContext, calledJob);
        allStepResults.push(result);

        if (!options.verbose) {
          console.log(`    ${formatStepStatus(result.status, result.name, result.duration)}`);
        }

        if (result.status === 'failure') {
          overallStatus = 'failure';
          if (result.error) {
            console.log(`      ${colors.red}Error: ${result.error}${colors.reset}`);
          } else if (result.exitCode !== undefined && result.exitCode !== 0) {
            console.log(`      ${colors.red}Exit code: ${result.exitCode}${colors.reset}`);
          } else {
            console.log(`      ${colors.red}Step failed${colors.reset}`);
          }
          if (!step['continue-on-error']) {
            break;
          }
        }
      }
    } finally {
      await endJob(calledContext);
    }

    // Extract outputs from this job
    const calledOutputs = extractJobOutputs(calledJob, calledContext.stepOutputs);
    if (calledOutputs) {
      calledJobOutputs[calledJobId] = calledOutputs;
    }

    if (overallStatus === 'failure') {
      break;
    }
  }

  // Map workflow-level outputs from job outputs
  const workflowOutputs = extractWorkflowOutputs(reusableWorkflow, calledJobOutputs);

  return {
    jobId,
    jobName: job.name || jobId,
    steps: allStepResults,
    status: overallStatus,
    duration: Date.now() - startTime,
    outputs: workflowOutputs,
  };
}

/** End what a job's steps left running; a failure to is said, and the run goes on. */
async function endJob(context: ExecutionContext): Promise<void> {
  try {
    await context.runner.endJob();
  } catch (err) {
    console.log(`  ${colors.yellow}Could not end what the job's steps left running: ${(err as Error).message}${colors.reset}`);
  }
}

/**
 * Extract job outputs from step outputs using the job's output definitions.
 */
export function extractJobOutputs(
  job: WorkflowJob,
  stepOutputs: Record<string, Record<string, string>>
): Record<string, string> | undefined {
  if (!job.outputs) {
    return undefined;
  }

  const result: Record<string, string> = {};

  for (const [outputName, expression] of Object.entries(job.outputs)) {
    // Parse expressions like ${{ steps.check.outputs.runner }}
    const match = expression.match(/\$\{\{\s*steps\.([\w-]+)\.outputs\.([\w-]+)\s*\}\}/);
    if (match) {
      const [, stepId, outputKey] = match;
      const value = stepOutputs[stepId]?.[outputKey];
      if (value !== undefined) {
        result[outputName] = value;
      }
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Extract workflow-level outputs from job outputs.
 */
export function extractWorkflowOutputs(
  workflow: ReusableWorkflow,
  jobOutputs: JobOutputs
): Record<string, string> | undefined {
  if (Object.keys(workflow.outputs).length === 0) {
    return undefined;
  }

  const result: Record<string, string> = {};

  for (const [outputName, outputDef] of Object.entries(workflow.outputs)) {
    // Parse expressions like ${{ jobs.check.outputs.runner }}
    const match = outputDef.value.match(/\$\{\{\s*jobs\.([\w-]+)\.outputs\.([\w-]+)\s*\}\}/);
    if (match) {
      const [, jobId, outputKey] = match;
      const value = jobOutputs[jobId]?.[outputKey];
      if (value !== undefined) {
        result[outputName] = value;
      }
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Resolve workflow path from user input.
 */
function resolveWorkflowPath(input: string | undefined, cwd: string): string {
  if (!input) {
    // Auto-detect
    const defaultWorkflow = findDefaultWorkflow(cwd);
    if (!defaultWorkflow) {
      const workflows = findWorkflowFiles(cwd);
      if (workflows.length === 0) {
        throw new Error('No workflow files found in .github/workflows/');
      }
      throw new Error(
        `Multiple workflows found. Specify one:\n${workflows.map((w) => `  ${path.relative(cwd, w)}`).join('\n')}`
      );
    }
    return defaultWorkflow;
  }

  // Check if it's a full path
  if (input.includes('/')) {
    const fullPath = path.isAbsolute(input) ? input : path.join(cwd, input);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Workflow not found: ${input}`);
    }
    return fullPath;
  }

  // Try as workflow name
  const workflowDir = path.join(cwd, '.github', 'workflows');
  const candidates = [
    path.join(workflowDir, input),
    path.join(workflowDir, `${input}.yml`),
    path.join(workflowDir, `${input}.yaml`),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Workflow not found: ${input}`);
}


/** Ask a yes/no question on the terminal; a yes is y or yes, anything else no. */
async function askOnTerminal(question: string): Promise<string> {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>(resolve => {
    rl.question(question, a => {
      rl.close();
      resolve(a);
    });
  });
}

const isYes = (answer: string): boolean => /^y(es)?$/i.test(answer.trim());

/**
 * What a policy grants a step beyond its workspace: every host. Filesystem
 * grants are not given in the macOS VM yet (see unprovidedGrants), so they
 * are not asked about.
 */
export function grantsBeyondWorkspace(policy: PolicyRules | undefined): PolicyAddition[] {
  return nonEmpty([{ label: 'network.allow', items: policy?.network?.allow ?? [] }]);
}

/** Where the checkouts' confirmed grants are kept: the app data directory, which no step can reach. */
const checkoutApprovalsPath = (): string => path.join(getAppDataDirWithoutElectron(), 'test-approvals.json');

function readCheckoutApprovals(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(checkoutApprovalsPath(), 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const grantsDigest = (grants: PolicyAddition[]): string =>
  crypto.createHash('sha256').update(JSON.stringify(grants)).digest('hex');

/**
 * Ask before running a checkout whose .localmostrc grants it more than its
 * workspace, and remember a yes for that checkout and exactly those grants.
 *
 * The policy is the checkout's own to write, like the rest of it, and it is
 * what confines the checkout: applied without asking, it could let its code
 * reach any host it likes with whatever the run hands it.
 * A yes is remembered by where the checkout sits, which it cannot choose,
 * never by the repository name it claims; any change to the grants is asked
 * again. Without a terminal, only --yes runs it.
 */
export async function confirmCheckoutGrants(
  sourceDir: string,
  grants: PolicyAddition[],
  options: { assumeYes: boolean; isTTY: boolean; ask?: (question: string) => Promise<string> }
): Promise<boolean> {
  if (grants.length === 0) return true;
  const checkoutKey = fs.realpathSync(sourceDir);
  const digest = grantsDigest(grants);
  if (readCheckoutApprovals()[checkoutKey] === digest) return true;

  console.log(`${colors.bold}This checkout's .localmostrc grants its workflow more than its workspace:${colors.reset}`);
  for (const { label, items } of grants) {
    console.log(`  ${colors.bold}${label}${colors.reset}`);
    for (const item of items) console.log(`    ${colors.yellow}+${colors.reset} ${item}`);
  }
  console.log('The policy comes from the checkout itself. Run it only if you would grant these to its code.');
  console.log();

  if (options.assumeYes) return true;
  if (!options.isTTY) return false;

  if (!isYes(await (options.ask ?? askOnTerminal)('Run with these grants? [y/N] '))) return false;
  const approvals = { ...readCheckoutApprovals(), [checkoutKey]: digest };
  fs.mkdirSync(path.dirname(checkoutApprovalsPath()), { recursive: true, mode: 0o700 });
  const partial = `${checkoutApprovalsPath()}.${crypto.randomBytes(8).toString('hex')}`;
  fs.writeFileSync(partial, JSON.stringify(approvals, null, 2), { mode: 0o600, flag: 'wx' });
  fs.renameSync(partial, checkoutApprovalsPath());
  return true;
}

/**
 * Ask before a discovery run, every time.
 *
 * Discovery has to see which hosts a workflow reaches, so it lets the
 * checkout reach any host through the proxy. That is only safe on a
 * checkout you would trust with it, and nothing about a checkout says
 * whether it is one, so it is not remembered.
 */
export async function confirmDiscovery(options: {
  assumeYes: boolean;
  isTTY: boolean;
  ask?: (question: string) => Promise<string>;
}): Promise<boolean> {
  console.log(`${colors.yellow}${colors.bold}--updaterc runs this checkout with wide network access:${colors.reset}`);
  console.log('  Its steps run in a macOS VM, but can reach any host on the internet through the');
  console.log('  run\'s proxy, with any secret the run hands them. Use it only on a checkout whose');
  console.log('  code you trust.');
  console.log();
  if (options.assumeYes) return true;
  if (!options.isTTY) return false;
  return isYes(await (options.ask ?? askOnTerminal)('Run discovery? [y/N] '));
}

/**
 * List what a discovery run wants to add, and the file it will write it to,
 * and ask before writing it.
 *
 * `.localmostrc` is checked in and grants network access, so a discovery run
 * must not widen it silently. Without a terminal to ask on, nothing is written
 * unless --yes was passed.
 */
async function confirmPolicyChange(
  destination: string,
  additions: { label: string; items: string[] }[],
  assumeYes: boolean
): Promise<boolean> {
  console.log();
  console.log(`${colors.bold}These will be added to ${destination}:${colors.reset}`);
  for (const { label, items } of additions) {
    if (items.length === 0) continue;
    console.log(`  ${colors.bold}${label}${colors.reset}`);
    for (const item of items) {
      console.log(`    ${colors.green}+${colors.reset} ${item}`);
    }
  }
  console.log();

  if (assumeYes) return true;

  if (!process.stdin.isTTY) {
    console.log(`${colors.yellow}Not writing:${colors.reset} no terminal to confirm on. Re-run with --yes to apply.`);
    return false;
  }

  const yes = isYes(await askOnTerminal('Apply these changes? [y/N] '));
  if (!yes) console.log('Not writing.');
  return yes;
}

/**
 * Read secrets from a KEY=value file, in the shape people already keep them.
 */
function readSecretFile(filePath: string): Record<string, string> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Secret file not found: ${filePath}`);
  }

  const secrets: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(resolved, 'utf-8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (name) secrets[name] = value;
  }
  return secrets;
}

/**
 * Ask for a secret without echoing it to the terminal.
 */
async function promptForSecret(name: string): Promise<string> {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  const asStream = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput?: (s: string) => void };
  const prompt = `  ${name}: `;
  asStream._writeToOutput = (chunk: string) => {
    // Echo the prompt, never the value being typed.
    if (chunk.includes(name)) asStream.output.write(chunk);
  };

  const value = await new Promise<string>(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer);
    });
  });
  process.stdout.write('\n');
  return value;
}

/** The environment variable a secret is read from: never the secret's own name. */
const secretEnvName = (name: string): string => `LOCALMOST_SECRET_${name}`;

/**
 * Resolve the secrets a workflow references.
 *
 * Order is: a --secret-file entry, then LOCALMOST_SECRET_<name> in the
 * environment, then whatever the chosen mode does about what is left.
 * Nothing is written to disk, and values are masked out of step output by
 * the executor.
 *
 * The workflow chooses which names it asks for, and the checkout is as
 * untrusted as its code. Read under their own names, a workflow asking for
 * AWS_SECRET_ACCESS_KEY or GITHUB_TOKEN got whatever the developer had
 * exported for other tools; the prefix makes passing one a decision.
 */
export async function resolveSecrets(
  _repository: string,
  names: string[],
  mode: 'stub' | 'prompt' | 'abort',
  secretFile?: string
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const fromFile = secretFile ? readSecretFile(secretFile) : {};
  const stubbed: string[] = [];

  for (const name of names) {
    const fileValue = fromFile[name];
    if (fileValue !== undefined) {
      result[name] = fileValue;
      console.log(`  ${success(name)} (from secret file)`);
      continue;
    }

    const envValue = process.env[secretEnvName(name)];
    if (envValue !== undefined) {
      result[name] = envValue;
      console.log(`  ${success(name)} (from ${secretEnvName(name)})`);
      continue;
    }

    if (process.env[name] !== undefined) {
      console.log(
        `  ${colors.dim}${name} is set in your environment but not used; set ${secretEnvName(name)} to pass it to the workflow.${colors.reset}`
      );
    }

    switch (mode) {
      case 'abort':
        throw new Error(
          `Missing secret: ${name}. Set ${secretEnvName(name)} or pass --secret-file.`
        );

      case 'prompt': {
        if (!process.stdin.isTTY) {
          throw new Error(
            `Missing secret: ${name}. There is no terminal to prompt on - set ${secretEnvName(name)} or pass --secret-file.`
          );
        }
        result[name] = await promptForSecret(name);
        console.log(`  ${success(name)} (entered)`);
        break;
      }

      case 'stub':
        result[name] = '';
        stubbed.push(name);
        console.log(`  ${skipped(name)} (stubbed - empty string)`);
        break;
    }
  }

  if (stubbed.length > 0) {
    // An empty string is a value, and a step will act on it: deploying with an
    // empty token or publishing with an empty key does not look like a failure
    // until afterwards.
    console.log();
    console.log(
      `${colors.yellow}Warning:${colors.reset} ${stubbed.join(', ')} ${stubbed.length === 1 ? 'was' : 'were'} replaced with an empty string.`
    );
    console.log(
      `  Steps using ${stubbed.length === 1 ? 'it' : 'them'} will run anyway and may behave differently than on GitHub.`
    );
    console.log('  Use --secret-file, set LOCALMOST_SECRET_<name>, or --secrets abort to stop instead.');
  }

  return result;
}

/**
 * Handle --updaterc flag to generate/update .localmostrc.
 *
 * Uses the hosts the workflow reached through the run's proxy to generate a
 * .localmostrc with only what your workflow actually needs. Filesystem
 * access is not recorded: nothing traces it in the macOS VM yet.
 */
export async function handleUpdateRc(
  cwd: string,
  workflow: ParsedWorkflow,
  found: DiscoveredAccess,
  assumeYes: boolean
): Promise<void> {
  // A host the URL parser accepts can still be one no network entry can
  // name - an empty label, one over 63 characters. Written in, it would
  // leave a .localmostrc that no longer parses, so it is reported instead.
  const unwritableHosts = found.hosts.filter((host) => hostPatternProblem(host) !== null);
  const discovered: DiscoveredAccess = { ...found, hosts: found.hosts.filter((host) => !unwritableHosts.includes(host)) };
  const discoveredHosts = discovered.hosts;
  const dockerHints = discovered.dockerHints ?? [];

  console.log();
  console.log(`${colors.bold}Discovery Results:${colors.reset}`);

  // Report network access
  if (discoveredHosts.length === 0) {
    console.log(`  Network: ${colors.dim}No network access detected${colors.reset}`);
  } else {
    console.log(`  Network: ${discoveredHosts.length} host(s) discovered`);
    for (const host of discoveredHosts.slice(0, 5)) {
      console.log(`    ${colors.dim}- ${host}${colors.reset}`);
    }
    if (discoveredHosts.length > 5) {
      console.log(`    ${colors.dim}... and ${discoveredHosts.length - 5} more${colors.reset}`);
    }
  }
  if (unwritableHosts.length > 0) {
    console.log(`  Network: ${unwritableHosts.length} host(s) reached but not written, as no entry can name them`);
    for (const host of unwritableHosts) {
      console.log(`    ${colors.yellow}- ${host}${colors.reset} ${colors.dim}${hostPatternProblem(host)}${colors.reset}`);
    }
  }

  // The kernel's sandbox trace that recorded paths is gone with the
  // sandbox; recording the paths a step misses in the guest is to come.
  console.log(`  Filesystem: ${colors.dim}not recorded - discovery in the macOS VM does not trace filesystem access yet${colors.reset}`);

  // Report what the filtering docker socket refused. Each denial's hint is
  // the policy that would have permitted it, and those are what get written.
  if (dockerHints.length > 0) {
    console.log(`  Docker: ${dockerHints.length} request(s) refused by the filtering socket`);
  }

  console.log();

  // Check if there's anything to add
  if (discoveredHosts.length === 0 && dockerHints.length === 0) {
    console.log(`${colors.yellow}No access to configure.${colors.reset}`);
    console.log('This may happen if:');
    console.log('  - Your workflow doesn\'t make network requests');
    console.log('  - The tools used don\'t respect HTTP_PROXY environment variable');
    return;
  }

  const existingPath = findLocalmostrc(cwd);
  let existing: LocalmostrcConfig | undefined;
  if (existingPath) {
    const result = parseLocalmostrc(existingPath);
    if (!result.success || !result.config) {
      console.log(`${colors.yellow}Warning:${colors.reset} Could not parse existing .localmostrc: ${result.errors[0]?.message}`);
      return;
    }
    existing = result.config;
  }

  const { config, additions } = mergeDiscoveredAccess(existing, discovered, workflow.name);
  if (additions.length === 0) {
    if (existingPath) {
      console.log(`${colors.green}✓${colors.reset} ${path.relative(cwd, existingPath)} already includes all discovered access.`);
    } else {
      console.log(`${colors.yellow}Nothing to write to .localmostrc.${colors.reset}`);
    }
    return;
  }

  // Named as the file it is, with any link in the path to the checkout
  // resolved: findLocalmostrc has refused anything at the name itself but a
  // regular file, and writeLocalmostrc will not follow one put there later.
  const destination = path.join(cwd, LOCALMOSTRC_FILENAME);
  const resolved = path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination));
  const approved = await confirmPolicyChange(resolved, additions, assumeYes);
  if (!approved) return;

  writeLocalmostrc(destination, serializeLocalmostrc(config));
  console.log(`${colors.green}✓${colors.reset} ${existingPath ? 'Updated' : 'Created'} ${path.relative(cwd, destination)}`);
}

/** What a discovery run found that a policy could grant. */
export interface DiscoveredAccess {
  /** Hosts reached through the discovery proxy. */
  hosts: string[];
  /**
   * What the filtering docker socket refused, as the hints its denials log:
   * each the YAML under `docker:` that would have permitted the request.
   */
  dockerHints?: string[];
}

/** One policy key and the values a discovery run would add under it. */
export interface PolicyAddition {
  label: string;
  items: string[];
}

const nonEmpty = (additions: PolicyAddition[]): PolicyAddition[] =>
  additions.filter((a) => a.items.length > 0);

/** The docker policy a run's denials asked for, folded from their hints; undefined when none read. */
function dockerPolicyFromHints(hints: string[]): DockerPolicy | undefined {
  let policy: DockerPolicy | undefined;
  for (const hint of hints) {
    const parsed = parseDockerPolicyHint(hint);
    if (parsed) policy = mergeDockerPolicy(policy, parsed);
  }
  return policy;
}

/**
 * The docker grants `merged` has that `existing` lacks, one addition per
 * policy key, named the way the approval diff names them. A bare action
 * (`run: {}`) is a grant with no item for the diff to show, so it is listed
 * on its own.
 */
function dockerAdditions(existing: DockerPolicy | undefined, merged: DockerPolicy | undefined): PolicyAddition[] {
  const byLabel = new Map<string, string[]>();
  for (const diff of diffDockerPolicy(existing, merged, 'docker')) {
    if (diff.newValue === undefined) continue;
    const item = diff.type === 'changed' ? `${diff.newValue} (was ${diff.oldValue})` : diff.newValue;
    byLabel.set(diff.path, [...(byLabel.get(diff.path) ?? []), item]);
  }
  for (const action of ['run', 'build'] as const) {
    if (!merged?.[action] || existing?.[action]) continue;
    if ([...byLabel.keys()].some((label) => label.startsWith(`docker.${action}.`))) continue;
    byLabel.set(`docker.${action}`, ['{}']);
  }
  return [...byLabel].map(([label, items]) => ({ label, items }));
}

/**
 * Merge what a discovery run found into a .localmostrc, listing each grant it
 * adds. An existing policy keeps everything it has and gains only what it
 * lacks; with none, a new one is started from the discovered access with an
 * empty entry for the workflow. Empty `additions` means nothing is new.
 */
export function mergeDiscoveredAccess(
  existing: LocalmostrcConfig | undefined,
  discovered: DiscoveredAccess,
  workflowName: string
): { config: LocalmostrcConfig; additions: PolicyAddition[] } {
  const { hosts } = discovered;
  const suggestedDocker = dockerPolicyFromHints(discovered.dockerHints ?? []);

  if (!existing) {
    const config: LocalmostrcConfig = {
      version: LOCALMOSTRC_VERSION,
      shared: {
        network: hosts.length > 0 ? {
          allow: hosts,
        } : undefined,
        ...(suggestedDocker ? { docker: suggestedDocker } : {}),
      },
      workflows: {
        [workflowName]: {},
      },
    };
    const additions = nonEmpty([
      { label: 'network.allow', items: hosts },
      ...dockerAdditions(undefined, suggestedDocker),
    ]);
    // The workflow's entry is written too, so it is listed with the rest.
    // Its name is whatever the workflow file says, so it is shown quoted, as
    // it is written, where a newline or a terminal escape in it shows as one.
    if (additions.length > 0) {
      additions.push({ label: 'workflows', items: [JSON.stringify(workflowName)] });
    }
    return { config, additions };
  }

  // Calculate new items to add
  const existingHosts = new Set(existing.shared?.network?.allow || []);
  const newHosts = hosts.filter(h => !existingHosts.has(h));

  // Docker composes additively, so a hint only ever adds to what is declared.
  const existingDocker = existing.shared?.docker;
  const docker = suggestedDocker ? mergeDockerPolicy(existingDocker, suggestedDocker) : existingDocker;

  // Merge new items into existing config
  const config: LocalmostrcConfig = {
    ...existing,
    shared: {
      ...existing.shared,
      network: {
        ...existing.shared?.network,
        allow: [...(existing.shared?.network?.allow || []), ...newHosts],
      },
      ...(docker ? { docker } : {}),
    },
  };
  const additions = nonEmpty([
    { label: 'network.allow', items: newHosts },
    ...dockerAdditions(existingDocker, docker),
  ]);
  return { config, additions };
}

// =============================================================================
// CLI Entry Point
// =============================================================================

/**
 * Parse test command arguments.
 */
export function parseTestArgs(args: string[]): TestOptions {
  const options: TestOptions = {};
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg === '--updaterc' || arg === '-u') {
      options.updaterc = true;
    } else if (arg === '--yes' || arg === '-y') {
      options.assumeYes = true;
    } else if (arg === '--secret-file') {
      const value = args[++i];
      if (!value) throw new Error('--secret-file requires a path');
      options.secretFile = value;
    } else if (arg === '--full-matrix' || arg === '-f') {
      options.fullMatrix = true;
    } else if (arg === '--matrix' || arg === '-m') {
      options.matrix = args[++i];
    } else if (arg === '--job' || arg === '-j') {
      options.job = args[++i];
    } else if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--staged') {
      options.staged = true;
    } else if (arg === '--no-ignore') {
      options.noIgnore = true;
    } else if (arg === '--env' || arg === '-e') {
      options.showEnv = true;
    } else if (arg === '--secrets') {
      const mode = args[++i] as 'stub' | 'prompt' | 'abort';
      if (!['stub', 'prompt', 'abort'].includes(mode)) {
        throw new Error(`Invalid secrets mode: ${mode}. Use stub, prompt, or abort.`);
      }
      options.secretMode = mode;
    } else if (arg === '--debug') {
      throw new Error(
        '--debug was removed: it saved the sandbox trace of the old filesystem discovery, ' +
          'which a run in the macOS VM does not make. Use --verbose for the steps\' output.'
      );
    } else if (arg.startsWith('-')) {
      // Ignored, a misspelt or removed flag ran the workflow without the
      // option the user asked for.
      throw new Error(`Unknown option for localmost test: ${arg}. See localmost test --help.`);
    } else {
      options.workflow = arg;
    }

    i++;
  }

  return options;
}

/**
 * Print test command help.
 */
export function printTestHelp(): void {
  console.log(`
${colors.bold}localmost test${colors.reset} - Run workflows locally before pushing

${colors.bold}USAGE:${colors.reset}
  localmost test [workflow] [options]

${colors.bold}ARGUMENTS:${colors.reset}
  workflow          Workflow file or name (default: auto-detect)
                    Examples: build.yml, .github/workflows/ci.yml

${colors.bold}OPTIONS:${colors.reset}
  -j, --job <name>  Run specific job only
  -m, --matrix <spec>  Run specific matrix combination (e.g., "os=macos,node=18")
  -f, --full-matrix Run all matrix combinations
  -u, --updaterc    Discovery mode: record the hosts reached and generate
                    .localmostrc (filesystem access is not recorded yet)
  -y, --yes         Answer yes to every confirmation: a .localmostrc's grants
                    beyond the workspace, running --updaterc, and its changes
  -n, --dry-run     Show what would run without executing
  -v, --verbose     Show command output
  --staged          Use staged changes only (git diff --staged)
  --no-ignore       Include files ignored by .gitignore
  -e, --env         Show environment comparison after run
  --secrets <mode>  Handle missing secrets: stub (default), prompt, abort
  --secret-file <p> Read secrets from a KEY=value file

${colors.bold}EXAMPLES:${colors.reset}
  localmost test                    Run default workflow
  localmost test ci.yml             Run ci.yml workflow
  localmost test --job build-ios    Run only the build-ios job
  localmost test --updaterc         Generate .localmostrc from actual access
  localmost test -v --env           Verbose output with environment diff

${colors.bold}ENVIRONMENT:${colors.reset}
  Each run's steps run in a fresh macOS VM from localmost's golden image, as
  runner jobs do, so the localmost app must be running with the image built
  (Settings > macOS VM). Secrets come from a --secret-file or
  LOCALMOST_SECRET_<name> in the environment, never a variable under the
  secret's own name; they are never written to disk and are masked out of output.

${colors.bold}NETWORK:${colors.reset}
  The VM reaches the network only through the run's proxy. Allow hosts in
  .localmostrc:
    version: 1
    shared:
      network:
        allow:
          - registry.npmjs.org
`);
}
