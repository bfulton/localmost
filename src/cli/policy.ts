/**
 * CLI Policy Command
 *
 * Manage .localmostrc sandbox policies.
 *
 * Usage:
 *   localmost policy show              # Display current policy
 *   localmost policy diff              # Compare local vs approved
 *   localmost policy approve           # Show the policy and its stamp
 *   localmost policy approve --stamp S # Approve exactly that policy
 *   localmost policy validate          # Validate .localmostrc syntax
 */

import * as fs from 'fs';
import * as path from 'path';
import { DescribablePolicy, PolicyScope, describePolicy } from '../shared/policy-describe';
import {
  findLocalmostrc,
  parseLocalmostrc,
  diffConfigs,
  formatPolicyDiff,
  LocalmostrcConfig,
  serializeLocalmostrc,
  LOCALMOSTRC_VERSION,
} from '../shared/localmostrc';
import { getAppDataDirWithoutElectron } from '../shared/paths';
import { getRepositoryFromDir } from '../shared/workspace';
import {
  PolicyEntry,
  approvalStamp,
  approveConfig,
  readPolicyEntry,
  recordPolicyDecision,
} from '../shared/policy-store';
import { MACOS_BASELINE_READ_PATHS } from '../shared/sandbox-profile';

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

// =============================================================================
// Command Handlers
// =============================================================================

/**
 * Show the current policy for a repository.
 */
function handleShow(options: PolicyOptions): void {
  const cwd = process.cwd();
  const localmostrcPath = findLocalmostrc(cwd);

  if (!localmostrcPath) {
    console.log(`${colors.yellow}No .localmostrc found${colors.reset}`);
    console.log();
    console.log('Create one with:');
    console.log('  localmost test --updaterc');
    console.log();
    console.log('Or create manually:');
    console.log(`
version: 1
shared:
  network:
    allow:
      - registry.npmjs.org
      - github.com
`);
    return;
  }

  const result = parseLocalmostrc(localmostrcPath);
  if (!result.success || !result.config) {
    console.log(`${colors.red}Invalid .localmostrc:${colors.reset}`);
    for (const error of result.errors) {
      console.log(`  ${error.message}`);
    }
    process.exit(1);
  }

  console.log(`${colors.bold}Policy: ${colors.reset}${path.relative(cwd, localmostrcPath)}`);
  console.log();

  // Show specific workflow policy if requested. The two sections are shown
  // apart rather than merged: the runner applies a workflow's section only in
  // part, and merged, its env allow and filesystem grants read as grants the
  // runner makes.
  if (options.workflow) {
    const workflow = options.workflow;
    const { level, shared, workflows } = result.config;
    console.log(`${colors.bold}Policy for ${workflow}:${colors.reset}`);
    console.log();
    // The level is declared once, at the top of the file, and widens every
    // section, so it is shown with the shared one.
    console.log(`${colors.bold}Shared policy${colors.reset} ${colors.dim}(applies to every workflow)${colors.reset}`);
    printPolicy({ ...shared, level });
    console.log();
    const section = workflows?.[workflow];
    if (section) {
      console.log(`${colors.bold}Workflow: ${workflow}${colors.reset} ${colors.dim}(any pull request can claim this)${colors.reset}`);
      printPolicy(section, 'workflow');
    } else {
      console.log(`No section for ${workflow}: only the shared policy applies.`);
    }
    return;
  }

  printConfig(result.config);
}

/**
 * Print every section of a policy, the level with the shared one.
 */
function printConfig(config: LocalmostrcConfig): void {
  const level = config.level;
  if (config.shared || level) {
    console.log(`${colors.bold}Shared policy:${colors.reset}`);
    printPolicy({ ...config.shared, level });
    console.log();
  }

  if (config.workflows) {
    for (const [name, policy] of Object.entries(config.workflows)) {
      // A workflows: key is only a file name, and a pull request can add a
      // workflow file of any name.
      console.log(`${colors.bold}Workflow: ${name}${colors.reset} ${colors.dim}(any pull request can claim this)${colors.reset}`);
      printPolicy(policy, 'workflow');
      console.log();
    }
  }
}

/**
 * Print a policy section.
 *
 * Exported so a test can drive it directly: this is what an operator reads
 * before running `localmost policy approve`, so what it leaves out is approved
 * unseen.
 */
export function printPolicy(policy: DescribablePolicy, scope: PolicyScope = 'shared'): void {
  const grants = describePolicy(policy, '', scope);
  if (grants.length === 0) {
    console.log('  (empty - uses defaults only)');
    return;
  }

  const colorFor: Record<string, string> = { '+': colors.green, '-': colors.red, r: colors.cyan, w: colors.green };
  let group = '';
  for (const grant of grants) {
    if (grant.group !== group) {
      group = grant.group;
      console.log(`  ${group}:`);
    }
    const color = colorFor[grant.marker] ?? colors.green;
    const note = grant.note ? ` ${colors.dim}(${grant.note})${colors.reset}` : '';
    console.log(`    ${color}${grant.marker}${colors.reset} ${grant.value}${note}`);
    if (grant.warning) {
      console.log(`      ${colors.yellow}\u26A0 warning: ${grant.warning}${colors.reset}`);
    }
  }
}

function getPolicyCacheDir(): string {
  return path.join(getAppDataDirWithoutElectron(), 'policies');
}

/**
 * Read the policies the background runner has recorded for a repository: the
 * approved one and any pending one, in the app's own format.
 */
function readCachedPolicy(repository: string): PolicyEntry | null {
  try {
    return readPolicyEntry(getPolicyCacheDir(), repository);
  } catch (err) {
    console.log(`${colors.yellow}Ignoring the cached policy for ${repository}: ${(err as Error).message}${colors.reset}`);
    return null;
  }
}

/**
 * Compare the local .localmostrc to the approved policy.
 */
function handleDiff(): void {
  const cwd = process.cwd();
  const localPath = findLocalmostrc(cwd);

  if (!localPath) {
    console.log('No .localmostrc found in current directory.');
    return;
  }

  // Parse local
  const localResult = parseLocalmostrc(localPath);
  if (!localResult.success || !localResult.config) {
    console.log(`${colors.red}Invalid local .localmostrc:${colors.reset}`);
    for (const error of localResult.errors) {
      console.log(`  ${error.message}`);
    }
    process.exit(1);
  }

  // Load cached
  const repository = getRepositoryFromDir(cwd);
  if (!repository) {
    console.log('Could not detect repository.');
    return;
  }

  const approved = readCachedPolicy(repository)?.approved;

  if (!approved) {
    console.log('No approved policy - the runner will hold this repository\'s jobs until one is approved.');
    console.log(`Local policy: ${path.relative(cwd, localPath)} - review and approve it with "localmost policy approve"`);
    return;
  }

  // Compute diff
  const diffs = diffConfigs(approved.config, localResult.config);

  if (diffs.length === 0) {
    console.log(`${colors.green}\u2713${colors.reset} Policy unchanged and approved`);
    return;
  }

  console.log(`${colors.bold}Policy changes:${colors.reset}`);
  console.log();
  console.log(formatPolicyDiff(diffs));
}

/**
 * Approve the repository's current policy for use by the background runner.
 *
 * Two steps, like the app: the first shows the whole policy and the stamp of
 * exactly what was shown, and only a second run quoting that stamp approves.
 * Approving in one step meant approving a file nobody had been shown - only a
 * diff, printed afterwards, and nothing at all for a repository the runner
 * had not seen - and whatever it held at that moment.
 */
function handleApprove(options: PolicyOptions): void {
  const cwd = process.cwd();
  const repository = getRepositoryFromDir(cwd);
  if (!repository) {
    console.log('Could not detect repository.');
    process.exit(1);
  }

  const localPath = findLocalmostrc(cwd);
  if (!localPath) {
    console.log('No .localmostrc found - there is nothing to approve.');
    return;
  }

  const localResult = parseLocalmostrc(localPath);
  if (!localResult.success || !localResult.config) {
    console.log(`${colors.red}Invalid .localmostrc - fix it before approving:${colors.reset}`);
    for (const error of localResult.errors) {
      console.log(`  ${error.message}`);
    }
    process.exit(1);
  }

  const config = localResult.config;
  const stamp = approvalStamp(repository, config);

  if (options.stamp === undefined) {
    console.log(`${colors.bold}Policy for ${repository}:${colors.reset} ${path.relative(cwd, localPath)}`);
    console.log();
    printConfig(config);

    const cached = readCachedPolicy(repository);
    const approved = cached?.approved;
    if (approved) {
      const diffs = diffConfigs(approved.config, config);
      console.log(`${colors.bold}Changes from the approved policy:${colors.reset}`);
      console.log(diffs.length > 0 ? formatPolicyDiff(diffs) : 'None');
      console.log();
    }
    const otherRepository = pendingFromOtherRepository(repository, cached, stamp);
    if (otherRepository) {
      console.log(
        `${colors.yellow}⚠ A job from repository id ${otherRepository.now} is waiting with this same policy, ` +
          `but the approval is bound to repository id ${otherRepository.was}.${colors.reset}`
      );
      console.log(
        '  A different repository now holds this name: the approved one was deleted and recreated, or renamed ' +
          'and its name taken.'
      );
      console.log(
        '  Approving here keeps the approval with repository id ' +
          `${otherRepository.was}. To move it, review the request in Settings > Job Security.`
      );
      console.log();
    }

    console.log('Nothing has been approved yet. To approve exactly this policy, run:');
    console.log(`  localmost policy approve --stamp ${stamp}`);
    process.exit(1);
  }

  if (options.stamp !== stamp) {
    console.log(
      `${colors.red}The .localmostrc changed since that stamp was shown.${colors.reset} ` +
        'Run "localmost policy approve" again to review what it holds now.'
    );
    process.exit(1);
  }

  const dir = getPolicyCacheDir();
  try {
    approveConfig(dir, repository, config);
  } catch (err) {
    console.log(`${colors.red}Could not approve the policy for ${repository}:${colors.reset} ${(err as Error).message}`);
    process.exit(1);
  }
  // The approval is written by now, so a log that cannot be written is
  // reported rather than made to look as if the approval failed.
  try {
    recordPolicyDecision(dir, { repository, decision: 'approved', stamp, via: 'cli' });
  } catch (err) {
    console.log(`${colors.yellow}Could not record the decision in decisions.log: ${(err as Error).message}${colors.reset}`);
  }

  console.log(`${colors.green}\u2713${colors.reset} Approved policy for ${repository}`);
  console.log('The runner will apply it to the next job from this repository.');
  const stillWaiting = pendingFromOtherRepository(repository, readCachedPolicy(repository), stamp);
  if (stillWaiting) {
    console.log(
      `${colors.yellow}The request from repository id ${stillWaiting.now} is still waiting:${colors.reset} ` +
        'review it in Settings > Job Security.'
    );
  }
}

/**
 * A pending policy identical to the operator's file but from a different
 * repository than the approval is bound to - one that took the name. The
 * clone carries no id and the diff reads "None", so without this the CLI
 * would show nothing of it. approveConfig leaves the binding and the
 * request alone; only the app's card, which shows the id, can move it.
 */
function pendingFromOtherRepository(
  repository: string,
  entry: PolicyEntry | null,
  stamp: string
): { was: number; now: number } | null {
  const was = entry?.approved?.repositoryId;
  const now = entry?.pending?.repositoryId;
  if (was === undefined || now === undefined || was === now) return null;
  if (!entry?.pending || approvalStamp(repository, entry.pending.config) !== stamp) return null;
  return { was, now };
}

/**
 * Validate .localmostrc syntax.
 */
function handleValidate(): void {
  const cwd = process.cwd();
  const localPath = findLocalmostrc(cwd);

  if (!localPath) {
    console.log(`${colors.red}\u2717${colors.reset} No .localmostrc found`);
    process.exit(1);
  }

  const result = parseLocalmostrc(localPath);

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.log(`${colors.yellow}\u26A0${colors.reset} ${warning}`);
    }
  }

  if (result.success) {
    console.log(`${colors.green}\u2713${colors.reset} ${path.relative(cwd, localPath)} is valid`);
  } else {
    console.log(`${colors.red}\u2717${colors.reset} ${path.relative(cwd, localPath)} is invalid:`);
    for (const error of result.errors) {
      const location = error.line ? ` (line ${error.line})` : '';
      console.log(`  ${error.message}${location}`);
    }
    process.exit(1);
  }
}

/**
 * Initialize a new .localmostrc file.
 */
function handleInit(): void {
  const cwd = process.cwd();
  const existingPath = findLocalmostrc(cwd);

  if (existingPath) {
    console.log(`${colors.yellow}.localmostrc already exists:${colors.reset} ${path.relative(cwd, existingPath)}`);
    console.log('Use --force to overwrite.');
    return;
  }

  // Start from a policy that actually runs. Nothing is granted implicitly, so
  // without the read paths a macOS process needs, the first step would die
  // before executing anything.
  const template: LocalmostrcConfig = {
    version: LOCALMOSTRC_VERSION,
    // Declared rather than left implicit, so the level a repository runs at is
    // visible in the file and shows up in the diff if it ever changes.
    level: 'strict',
    shared: {
      network: {
        allow: [
          '*.github.com',
          'github.com',
          'registry.npmjs.org',
        ],
      },
      filesystem: {
        read: [...MACOS_BASELINE_READ_PATHS],
      },
    },
  };

  const content = serializeLocalmostrc(template);
  const newPath = path.join(cwd, '.localmostrc');
  fs.writeFileSync(newPath, content);

  console.log(`${colors.green}\u2713${colors.reset} Created .localmostrc`);
  console.log();
  console.log('Customize the policy, then run:');
  console.log('  localmost test --updaterc');
}

// =============================================================================
// Types
// =============================================================================

export interface PolicyOptions {
  /** Show policy for specific workflow */
  workflow?: string;
  /** Force overwrite */
  force?: boolean;
  /** The stamp `policy approve` printed for the policy being approved */
  stamp?: string;
}

// =============================================================================
// CLI Entry Point
// =============================================================================

/**
 * Run the policy command.
 */
export function runPolicy(
  subcommand: string,
  options: PolicyOptions
): void {
  switch (subcommand) {
    case 'show':
    case '':
      handleShow(options);
      break;
    case 'diff':
      handleDiff();
      break;
    case 'approve':
      handleApprove(options);
      break;

    case 'validate':
    case 'check':
      handleValidate();
      break;
    case 'init':
      handleInit();
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      printPolicyHelp();
      process.exit(1);
  }
}

/**
 * Parse policy command arguments.
 */
export function parsePolicyArgs(args: string[]): {
  subcommand: string;
  options: PolicyOptions;
} {
  const options: PolicyOptions = {};
  let subcommand = 'show';

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--workflow' || arg === '-w') {
      options.workflow = args[++i];
    } else if (arg === '--force' || arg === '-f') {
      options.force = true;
    } else if (arg === '--stamp') {
      options.stamp = args[++i];
    } else if (!arg.startsWith('-')) {
      subcommand = arg;
    }

    i++;
  }

  return { subcommand, options };
}

/**
 * Print policy command help.
 */
export function printPolicyHelp(): void {
  console.log(`
${colors.bold}localmost policy${colors.reset} - Manage sandbox policies

${colors.bold}USAGE:${colors.reset}
  localmost policy <subcommand> [options]

${colors.bold}SUBCOMMANDS:${colors.reset}
  show              Display current policy (default)
  diff              Compare local vs approved policy
  approve           Show this repo's policy and the stamp that approves it
  approve --stamp   Approve exactly the policy that stamp was shown for
  validate          Validate .localmostrc syntax
  init              Create a new .localmostrc template

${colors.bold}OPTIONS:${colors.reset}
  -w, --workflow <name>  Show the policy that applies to a specific workflow
  -f, --force            Overwrite existing file (for init)
  --stamp <sha256>       Approve only if the policy is still the one shown

${colors.bold}EXAMPLES:${colors.reset}
  localmost policy show
  localmost policy show --workflow build
  localmost policy diff
  localmost policy approve
  localmost policy validate
  localmost policy init

${colors.bold}POLICY FORMAT:${colors.reset}
  version: 1
  shared:                          # Applies to all workflows
    network:
      allow:
        - registry.npmjs.org
        - "*.github.com"
    filesystem:
      write:
        - ./build/**
  workflows:                       # Per-workflow overrides
    deploy:
      network:
        allow:
          - api.fastlane.tools
`);
}
