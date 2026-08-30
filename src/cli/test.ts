/**
 * CLI Test Command
 *
 * Runs GitHub Actions workflows locally before pushing.
 *
 * Usage:
 *   localmost test                              # Run default workflow
 *   localmost test .github/workflows/build.yml  # Run specific workflow
 *   localmost test build.yml --job build-ios    # Run specific job
 *   localmost test --updaterc                   # Discovery mode
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
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
  StepResult,
  StepStatus,
} from '../shared/step-executor';
import {
  findLocalmostrc,
  parseLocalmostrc,
  getEffectivePolicy,
  LocalmostrcConfig,
  serializeLocalmostrc,
  LOCALMOSTRC_VERSION,
} from '../shared/localmostrc';
import { SandboxPolicy, parseSandboxTrace, SandboxTraceResult } from '../shared/sandbox-profile';
import { DiscoveryProxy } from '../shared/discovery-proxy';
import { createWorkspace, cleanupWorkspaces, getGitInfo, getRepositoryFromDir } from '../shared/workspace';
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
  /** Skip the confirmation prompt when --updaterc rewrites a policy */
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
  /** Save debug info (sandbox logs, collected PIDs) */
  debug?: boolean;
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
// System Log Query for Sandbox Reports
// =============================================================================

/**
 * Query the macOS unified system log for sandbox reports.
 * Used in discovery mode to find what filesystem paths were accessed.
 *
 * The sandbox (with report) modifier logs to the kernel subsystem:
 *   kernel: (Sandbox) Sandbox: <process>(<pid>) allow <operation> <path>
 */
function querySandboxLogs(sinceSeconds: number): string {
  if (process.platform !== 'darwin') {
    return '';
  }

  // Query the unified log for sandbox reports.
  // Use /bin/bash explicitly and write to a temp file to avoid pipe issues.
  // Note /usr/bin/log, not `log`: zsh has a `log` builtin that shadows it.
  const stamp = Date.now();
  const tmpFile = `/tmp/localmost-sandbox-log-${stamp}.txt`;
  const scriptFile = `/tmp/localmost-query-log-${stamp}.sh`;

  try {
    const script = `#!/bin/bash
/usr/bin/log show --last ${sinceSeconds}s 2>/dev/null | grep "kernel: (Sandbox)" > "${tmpFile}" || true
`;
    fs.writeFileSync(scriptFile, script);
    execSync(`/bin/bash "${scriptFile}"`, { encoding: 'utf-8' });

    let output = '';
    if (fs.existsSync(tmpFile)) {
      output = fs.readFileSync(tmpFile, 'utf-8');
    }
    return output;
  } catch {
    // If log command fails, return empty string
    return '';
  } finally {
    // Cleanup belongs here: on the previous success-only path a throw left the
    // script and its output behind in /tmp for good.
    for (const file of [tmpFile, scriptFile]) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {
        // Best effort
      }
    }
  }
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

/**
 * Run the test command.
 */
export async function runTest(options: TestOptions = {}): Promise<TestResult> {
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
  let policy: SandboxPolicy | undefined;

  if (localmostrcPath) {
    console.log(`Using policy: ${path.relative(cwd, localmostrcPath)}`);
    const result = parseLocalmostrc(localmostrcPath);
    if (result.success && result.config) {
      config = result.config;
      policy = getEffectivePolicy(config, workflow.name);
    } else {
      console.log(`${colors.yellow}Warning:${colors.reset} Invalid .localmostrc: ${result.errors[0]?.message}`);
    }
  } else if (!options.updaterc) {
    console.log(`${colors.yellow}No .localmostrc found.${colors.reset} Run with --updaterc to generate.`);
    console.log('Running in strict mode (no network access allowed).');
    // policy stays undefined = empty allowlist
  }
  console.log();

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

  // Start proxy for network isolation (sandbox restricts traffic to proxy only)
  const discoveryProxy = new DiscoveryProxy({
    allowlist: networkAllowlist,
    onAccess: (host, port, allowed) => {
      if (options.verbose) {
        const status = allowed ? colors.dim : colors.red;
        const action = allowed ? '' : ' (BLOCKED)';
        console.log(`  ${status}[network] ${host}:${port}${action}${colors.reset}`);
      }
    },
  });
  const proxyPort = await discoveryProxy.start();

  // Everything after the proxy starts runs inside try/finally: a throw in
  // workspace setup, parsing or job execution would otherwise leave the proxy
  // listening and holding its sockets.
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
  console.log(`Workspace: ${workspace.path}`);
  console.log();

  // Get git info for GITHUB_SHA and GITHUB_REF
  const gitInfo = getGitInfo(cwd);

  // Build proxy environment variables
  const proxyUrl = discoveryProxy.getProxyUrl();

  // Create a tmp directory inside workDir for Unix sockets
  // This keeps sockets within the sandbox's allowed network paths
  const tmpDir = path.join(workspace.path, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  // Create sandbox trace log file
  // In updaterc mode: captures denies for policy generation
  // In enforcement mode: captures denies for error reporting
  const sandboxLogFile = path.join(workspace.path, '.sandbox-trace.log');

  const proxyEnv: Record<string, string> = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    TMPDIR: tmpDir,
  };

  // Track PIDs for discovery mode (to filter sandbox logs)
  // Uses kqueue-based pid_tree_watch for real-time process tree tracking
  const collectedPids = new Set<number>();

  // Build execution context
  const context: ExecutionContext = {
    workDir: workspace.path,
    proxyPort,
    workflowEnv: {
      GITHUB_WORKFLOW: workflow.name,
      GITHUB_REPOSITORY: repository,
      GITHUB_SHA: gitInfo?.sha || '',
      GITHUB_REF: gitInfo?.ref || '',
      ...(workflow.workflow.env || {}),
      ...proxyEnv,
    },
    jobEnv: {},
    matrix: {},
    secrets,
    stepOutputs: {},
    policy,
    permissive: options.updaterc,
    sandboxLogFile,
    collectedPids: options.updaterc ? collectedPids : undefined,
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

  // Record start time for system log query (discovery mode)
  const jobsStartTime = Date.now();

  for (const jobId of jobsToRun) {
    const job = workflow.workflow.jobs[jobId];
    const jobName = job.name || jobId;

    // Check if this is a reusable workflow call
    if (isReusableWorkflowJob(job)) {
      console.log(`${colors.bold}\u25B6 ${jobName}${colors.reset} ${colors.dim}(reusable workflow)${colors.reset}`);

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

      console.log(`${colors.bold}\u25B6 ${jobName}${matrixSuffix}${colors.reset}`);

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
  cleanupWorkspaces({ maxAgeHours: 24, maxCount: 10 });

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
    console.log(`\n${colors.green}${colors.bold}\u2713 Workflow passed${colors.reset}`);
  } else {
    console.log(`\n${colors.red}${colors.bold}\u2717 Workflow failed${colors.reset}`);

  }

  // Handle --updaterc (only write if workflow succeeded)
  if (options.updaterc) {
    const discoveredHosts = discoveryProxy.getAccessedHosts();

    // Query system log for sandbox reports (discovery mode uses 'with report')
    // Add a few seconds buffer to account for log write delay
    const elapsedSeconds = Math.ceil((Date.now() - jobsStartTime) / 1000) + 5;
    const logContent = querySandboxLogs(elapsedSeconds);

    // Save debug info if requested
    if (options.debug) {
      const debugDir = path.join(workspace.path, '.debug');
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }
      // Save raw sandbox log
      fs.writeFileSync(path.join(debugDir, 'sandbox-log.txt'), logContent);
      // Save collected PIDs
      fs.writeFileSync(
        path.join(debugDir, 'collected-pids.json'),
        JSON.stringify([...collectedPids], null, 2)
      );
      console.log(`${colors.dim}Debug info saved to ${debugDir}${colors.reset}`);
    }

    // Filter log entries to only include PIDs from our process tree
    // This eliminates noise from other sandboxed processes running concurrently
    const sandboxTrace = parseSandboxTrace(logContent, workspace.path, collectedPids);

    if (allSucceeded) {
      await handleUpdateRc(cwd, workflow, discoveredHosts, sandboxTrace, !!options.assumeYes);
    } else {
      console.log();
      console.log(`${colors.yellow}Skipping .localmostrc generation - workflow failed.${colors.reset}`);
      console.log('Fix the workflow issues first, then run --updaterc again.');
      if (discoveredHosts.length > 0) {
        console.log();
        console.log(`${colors.dim}Hosts discovered so far: ${discoveredHosts.join(', ')}${colors.reset}`);
      }
      if (sandboxTrace) {
        if (sandboxTrace.writePaths.length > 0) {
          console.log(`${colors.dim}Filesystem writes: ${sandboxTrace.writePaths.join(', ')}${colors.reset}`);
        }
        if (sandboxTrace.socketPaths.length > 0) {
          console.log(`${colors.dim}Socket access: ${sandboxTrace.socketPaths.join(', ')}${colors.reset}`);
        }
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
    await discoveryProxy.stop();
  }
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

    // Run steps in the called job
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


/**
 * List what a discovery run wants to add, and ask before writing it.
 *
 * `.localmostrc` is checked in and grants sandbox access, so a discovery run
 * must not widen it silently. Without a terminal to ask on, nothing is written
 * unless --yes was passed.
 */
async function confirmPolicyChange(
  additions: { label: string; items: string[] }[],
  assumeYes: boolean
): Promise<boolean> {
  console.log();
  console.log(`${colors.bold}These will be added to .localmostrc:${colors.reset}`);
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

  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => {
    rl.question('Apply these changes? [y/N] ', a => {
      rl.close();
      resolve(a);
    });
  });
  const yes = /^y(es)?$/i.test(answer.trim());
  if (!yes) console.log('Not writing.');
  return yes;
}

/**
 * Resolve secrets from environment variables or stub them.
 */
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

/**
 * Resolve the secrets a workflow references.
 *
 * Order is: a --secret-file entry, then the environment, then whatever the
 * chosen mode does about what is left. Nothing is written to disk, and values
 * are masked out of step output by the executor.
 */
async function resolveSecrets(
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

    const envValue = process.env[name];
    if (envValue !== undefined) {
      result[name] = envValue;
      console.log(`  ${success(name)} (from environment)`);
      continue;
    }

    switch (mode) {
      case 'abort':
        throw new Error(
          `Missing secret: ${name}. Set it in the environment or pass --secret-file.`
        );

      case 'prompt': {
        if (!process.stdin.isTTY) {
          throw new Error(
            `Missing secret: ${name}. There is no terminal to prompt on - set it in the environment or pass --secret-file.`
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
    console.log('  Use --secret-file, set them in the environment, or --secrets abort to stop instead.');
  }

  return result;
}

/**
 * Handle --updaterc flag to generate/update .localmostrc.
 *
 * Uses the hosts discovered during the workflow run to generate
 * a .localmostrc file with only the hosts your workflow actually needs.
 */
async function handleUpdateRc(
  cwd: string,
  workflow: ParsedWorkflow,
  discoveredHosts: string[],
  sandboxTrace: SandboxTraceResult | undefined,
  assumeYes: boolean
): Promise<void> {
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

  // Report filesystem access
  const readPaths = sandboxTrace?.readPaths || [];
  const writePaths = sandboxTrace?.writePaths || [];
  const socketPaths = sandboxTrace?.socketPaths || [];

  if (readPaths.length === 0 && writePaths.length === 0) {
    console.log(`  Filesystem: ${colors.dim}No access outside workDir${colors.reset}`);
  } else {
    if (readPaths.length > 0) {
      console.log(`  Filesystem reads: ${readPaths.length} path(s) need read access`);
      for (const p of readPaths.slice(0, 3)) {
        console.log(`    ${colors.dim}- ${p}${colors.reset}`);
      }
      if (readPaths.length > 3) {
        console.log(`    ${colors.dim}... and ${readPaths.length - 3} more${colors.reset}`);
      }
    }
    if (writePaths.length > 0) {
      console.log(`  Filesystem writes: ${writePaths.length} path(s) need write access`);
      for (const p of writePaths.slice(0, 3)) {
        console.log(`    ${colors.dim}- ${p}${colors.reset}`);
      }
      if (writePaths.length > 3) {
        console.log(`    ${colors.dim}... and ${writePaths.length - 3} more${colors.reset}`);
      }
    }
  }

  // Report socket access
  if (socketPaths.length > 0) {
    console.log(`  Sockets: ${socketPaths.length} socket(s) need access`);
    for (const p of socketPaths) {
      console.log(`    ${colors.dim}- ${p}${colors.reset}`);
    }
  }

  console.log();

  // Check if there's anything to add
  if (discoveredHosts.length === 0 && readPaths.length === 0 && writePaths.length === 0 && socketPaths.length === 0) {
    console.log(`${colors.yellow}No access to configure.${colors.reset}`);
    console.log('This may happen if:');
    console.log('  - Your workflow doesn\'t make network requests');
    console.log('  - The tools used don\'t respect HTTP_PROXY environment variable');
    console.log('  - All filesystem access was within the working directory');
    return;
  }

  const existingPath = findLocalmostrc(cwd);
  if (existingPath) {
    // Parse existing config and merge
    const result = parseLocalmostrc(existingPath);
    if (result.success && result.config) {
      const existing = result.config;

      // Calculate new items to add
      const existingHosts = new Set(existing.shared?.network?.allow || []);
      const newHosts = discoveredHosts.filter(h => !existingHosts.has(h));

      const existingReadPaths = new Set(existing.shared?.filesystem?.read || []);
      const newReadPaths = readPaths.filter(p => !existingReadPaths.has(p));

      const existingWritePaths = new Set(existing.shared?.filesystem?.write || []);
      const newWritePaths = writePaths.filter(p => !existingWritePaths.has(p));

      const existingSocketPaths = new Set(existing.shared?.sockets?.allow || []);
      const newSocketPaths = socketPaths.filter(p => !existingSocketPaths.has(p));

      if (newHosts.length === 0 && newReadPaths.length === 0 && newWritePaths.length === 0 && newSocketPaths.length === 0) {
        console.log(`${colors.green}✓${colors.reset} ${path.relative(cwd, existingPath)} already includes all discovered access.`);
        return;
      }

      // Merge new items into existing config
      const updatedConfig: LocalmostrcConfig = {
        ...existing,
        shared: {
          ...existing.shared,
          network: {
            ...existing.shared?.network,
            allow: [...(existing.shared?.network?.allow || []), ...newHosts],
          },
          filesystem: (newReadPaths.length > 0 || newWritePaths.length > 0 || existing.shared?.filesystem) ? {
            ...existing.shared?.filesystem,
            read: newReadPaths.length > 0 ? [...(existing.shared?.filesystem?.read || []), ...newReadPaths] : existing.shared?.filesystem?.read,
            write: newWritePaths.length > 0 ? [...(existing.shared?.filesystem?.write || []), ...newWritePaths] : existing.shared?.filesystem?.write,
          } : undefined,
          sockets: newSocketPaths.length > 0 || existing.shared?.sockets ? {
            ...existing.shared?.sockets,
            allow: [...(existing.shared?.sockets?.allow || []), ...newSocketPaths],
          } : undefined,
        },
      };

      const approved = await confirmPolicyChange(
        [
          { label: 'network.allow', items: newHosts },
          { label: 'filesystem.read', items: newReadPaths },
          { label: 'filesystem.write', items: newWritePaths },
          { label: 'sockets.allow', items: newSocketPaths },
        ],
        assumeYes
      );
      if (!approved) return;

      const content = serializeLocalmostrc(updatedConfig);
      fs.writeFileSync(existingPath, content);
      console.log(`${colors.green}✓${colors.reset} Updated ${path.relative(cwd, existingPath)}`);
    } else {
      console.log(`${colors.yellow}Warning:${colors.reset} Could not parse existing .localmostrc: ${result.errors[0]?.message}`);
    }
  } else {
    // Create new config with discovered access
    const newConfig: LocalmostrcConfig = {
      version: LOCALMOSTRC_VERSION,
      shared: {
        network: discoveredHosts.length > 0 ? {
          allow: discoveredHosts,
        } : undefined,
        filesystem: (readPaths.length > 0 || writePaths.length > 0) ? {
          read: readPaths.length > 0 ? readPaths : undefined,
          write: writePaths.length > 0 ? writePaths : undefined,
        } : undefined,
        sockets: socketPaths.length > 0 ? {
          allow: socketPaths,
        } : undefined,
      },
      workflows: {
        [workflow.name]: {},
      },
    };

    const approved = await confirmPolicyChange(
      [
        { label: 'network.allow', items: discoveredHosts },
        { label: 'filesystem.read', items: readPaths },
        { label: 'filesystem.write', items: writePaths },
        { label: 'sockets.allow', items: socketPaths },
      ],
      assumeYes
    );
    if (!approved) return;

    const content = serializeLocalmostrc(newConfig);
    const rcPath = path.join(cwd, '.localmostrc');
    fs.writeFileSync(rcPath, content);
    console.log(`${colors.green}✓${colors.reset} Created .localmostrc`);
  }
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
      options.debug = true;
    } else if (!arg.startsWith('-')) {
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
  -u, --updaterc    Discovery mode: record access and generate .localmostrc
  -y, --yes         Apply --updaterc changes without confirming
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
  Uses your local machine as the runner. Secrets come from the environment or
  a --secret-file; they are never written to disk and are masked out of output.

${colors.bold}SANDBOX:${colors.reset}
  Workflows run in a sandbox. Configure access in .localmostrc:
    version: 1
    shared:
      network:
        allow:
          - registry.npmjs.org
`);
}
