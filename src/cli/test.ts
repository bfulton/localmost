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
  getRequiredSecrets,
  LocalmostrcConfig,
  serializeLocalmostrc,
  LOCALMOSTRC_VERSION,
} from '../shared/localmostrc';
import { SandboxPolicy, DEFAULT_SANDBOX_POLICY } from '../shared/sandbox-profile';
import { createWorkspace, cleanupWorkspaces, getGitInfo } from '../shared/workspace';
import { getSecrets, hasSecret, storeSecret, getRepositoryFromDir } from '../shared/secrets';
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
    console.log('Running in permissive mode.');
    policy = DEFAULT_SANDBOX_POLICY;
  }
  console.log();

  // Handle secrets
  const secretNames = extractSecretReferences(workflow.workflow);
  let secrets: Record<string, string> = {};

  if (secretNames.length > 0) {
    console.log(`Secrets required: ${secretNames.join(', ')}`);
    secrets = await resolveSecrets(repository, secretNames, options.secretMode || 'stub');
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

  // Build execution context
  const context: ExecutionContext = {
    workDir: workspace.path,
    workflowEnv: {
      GITHUB_WORKFLOW: workflow.name,
      GITHUB_REPOSITORY: repository,
      GITHUB_SHA: gitInfo?.sha || '',
      GITHUB_REF: gitInfo?.ref || '',
      ...(workflow.workflow.env || {}),
    },
    jobEnv: {},
    matrix: {},
    secrets,
    stepOutputs: {},
    policy,
    permissive: options.updaterc || !localmostrcPath,
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

  for (const jobId of jobsToRun) {
    const job = workflow.workflow.jobs[jobId];
    const jobName = job.name || jobId;

    // Determine matrix combinations
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
        options
      );

      jobResults.push(jobResult);
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

    // Compare to first job's runs-on
    const firstJob = workflow.workflow.jobs[jobsToRun[0]];
    const runsOn = Array.isArray(firstJob['runs-on']) ? firstJob['runs-on'][0] : firstJob['runs-on'];
    const diffs = compareEnvironments(localEnv, runsOn);
    environmentDiffs = formatEnvironmentDiff(diffs);
    console.log(environmentDiffs);
  }

  // Show summary
  console.log(colors.bold + 'Summary:' + colors.reset);
  console.log(`  Duration: ${formatDuration(duration)}`);
  console.log(`  Jobs: ${jobResults.filter((j) => j.status === 'success').length}/${jobResults.length} passed`);

  if (allSucceeded) {
    console.log(`\n${colors.green}${colors.bold}\u2713 Workflow passed${colors.reset}`);
  } else {
    console.log(`\n${colors.red}${colors.bold}\u2717 Workflow failed${colors.reset}`);
  }

  // Handle --updaterc
  if (options.updaterc) {
    await handleUpdateRc(cwd, workflow, context);
  }

  return {
    success: allSucceeded,
    workflow: workflow.name,
    jobResults,
    duration,
    environmentDiffs,
  };
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
  options: TestOptions
): Promise<JobResult> {
  const startTime = Date.now();
  const stepResults: StepResult[] = [];
  let jobStatus: 'success' | 'failure' | 'skipped' = 'success';

  for (const step of job.steps) {
    if (options.dryRun) {
      const stepName = step.name || step.id || (step.uses ? `Run ${step.uses}` : 'Run script');
      console.log(`  ${pending(stepName)} (dry run)`);
      continue;
    }

    const result = await executeStep(step, context, job);
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
      }
      // Stop on first failure (unless continue-on-error)
      if (!step['continue-on-error']) {
        break;
      }
    }
  }

  return {
    jobId,
    jobName: job.name || jobId,
    matrix: Object.keys(matrix).length > 0 ? matrix : undefined,
    steps: stepResults,
    status: jobStatus,
    duration: Date.now() - startTime,
  };
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
 * Resolve secrets from storage or stub them.
 */
async function resolveSecrets(
  repository: string,
  names: string[],
  mode: 'stub' | 'prompt' | 'abort'
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  for (const name of names) {
    if (hasSecret(repository, name)) {
      result[name] = (await getSecrets(repository, [name]))[name] || '';
      console.log(`  ${success(name)} (from keychain)`);
    } else {
      switch (mode) {
        case 'abort':
          throw new Error(`Missing secret: ${name}. Set it with: localmost secrets set ${name}`);
        case 'stub':
          result[name] = '';
          console.log(`  ${skipped(name)} (stubbed)`);
          break;
        case 'prompt':
          // In a full implementation, would prompt for input
          result[name] = '';
          console.log(`  ${skipped(name)} (would prompt)`);
          break;
      }
    }
  }

  return result;
}

/**
 * Handle --updaterc flag to generate/update .localmostrc.
 */
async function handleUpdateRc(
  cwd: string,
  workflow: ParsedWorkflow,
  context: ExecutionContext
): Promise<void> {
  console.log();
  console.log(`${colors.bold}Discovery mode:${colors.reset}`);
  console.log('Recording access patterns for .localmostrc generation.');
  console.log();

  // In a full implementation, would parse sandbox logs for actual access
  // For now, generate a template based on the workflow

  const existingPath = findLocalmostrc(cwd);
  if (existingPath) {
    console.log(`Would update: ${existingPath}`);
  } else {
    const newConfig: LocalmostrcConfig = {
      version: LOCALMOSTRC_VERSION,
      shared: {
        network: {
          allow: [
            '*.github.com',
            'github.com',
            'registry.npmjs.org',
          ],
        },
      },
      workflows: {
        [workflow.name]: {},
      },
    };

    const content = serializeLocalmostrc(newConfig);
    console.log('Would create .localmostrc:');
    console.log(colors.dim + content + colors.reset);
    console.log();
    console.log('Run this command to create the file:');
    console.log(`  echo '${content.replace(/'/g, "'\\''")}' > .localmostrc`);
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
  -n, --dry-run     Show what would run without executing
  -v, --verbose     Show command output
  --staged          Use staged changes only (git diff --staged)
  --no-ignore       Include files ignored by .gitignore
  -e, --env         Show environment comparison after run
  --secrets <mode>  Handle missing secrets: stub (default), prompt, abort

${colors.bold}EXAMPLES:${colors.reset}
  localmost test                    Run default workflow
  localmost test ci.yml             Run ci.yml workflow
  localmost test --job build-ios    Run only the build-ios job
  localmost test --updaterc         Generate .localmostrc from actual access
  localmost test -v --env           Verbose output with environment diff

${colors.bold}ENVIRONMENT:${colors.reset}
  Uses your local machine as the runner. Set up secrets with:
    localmost secrets set SECRET_NAME

${colors.bold}SANDBOX:${colors.reset}
  Workflows run in a sandbox. Configure access in .localmostrc:
    version: 1
    shared:
      network:
        allow:
          - registry.npmjs.org
`);
}
