/**
 * CLI Policy Command
 *
 * Manage .localmostrc sandbox policies.
 *
 * Usage:
 *   localmost policy show              # Display current policy
 *   localmost policy diff              # Compare local vs cached
 *   localmost policy validate          # Validate .localmostrc syntax
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  findLocalmostrc,
  parseLocalmostrc,
  diffConfigs,
  formatPolicyDiff,
  getEffectivePolicy,
  LocalmostrcConfig,
  serializeLocalmostrc,
  LOCALMOSTRC_VERSION,
} from '../shared/localmostrc';
import { getAppDataDirWithoutElectron } from '../shared/paths';
import { getRepositoryFromDir } from '../shared/workspace';

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

  // Show specific workflow policy if requested
  if (options.workflow) {
    const effective = getEffectivePolicy(result.config, options.workflow);
    console.log(`${colors.bold}Effective policy for ${options.workflow}:${colors.reset}`);
    printPolicy(effective);
    return;
  }

  // Show full config
  if (result.config.shared) {
    console.log(`${colors.bold}Shared policy:${colors.reset}`);
    printPolicy(result.config.shared);
    console.log();
  }

  if (result.config.workflows) {
    for (const [name, policy] of Object.entries(result.config.workflows)) {
      console.log(`${colors.bold}Workflow: ${name}${colors.reset}`);
      printPolicy(policy);
      console.log();
    }
  }
}

interface PrintablePolicy {
  network?: { allow?: string[]; deny?: string[] };
  filesystem?: { read?: string[]; write?: string[]; deny?: string[] };
  env?: { allow?: string[]; deny?: string[] };
}

/**
 * Print a policy section.
 */
function printPolicy(policy: PrintablePolicy): void {
  if (!policy || Object.keys(policy).length === 0) {
    console.log('  (empty - uses defaults only)');
    return;
  }

  if (policy.network) {
    if (policy.network.allow?.length) {
      console.log('  Network allow:');
      for (const domain of policy.network.allow) {
        console.log(`    ${colors.green}+${colors.reset} ${domain}`);
      }
    }
    if (policy.network.deny?.length) {
      console.log('  Network deny:');
      for (const domain of policy.network.deny) {
        console.log(`    ${colors.red}-${colors.reset} ${domain}`);
      }
    }
  }

  if (policy.filesystem) {
    if (policy.filesystem.read?.length) {
      console.log('  Filesystem read:');
      for (const filePath of policy.filesystem.read) {
        console.log(`    ${colors.cyan}r${colors.reset} ${filePath}`);
      }
    }
    if (policy.filesystem.write?.length) {
      console.log('  Filesystem write:');
      for (const filePath of policy.filesystem.write) {
        console.log(`    ${colors.green}w${colors.reset} ${filePath}`);
      }
    }
    if (policy.filesystem.deny?.length) {
      console.log('  Filesystem deny:');
      for (const filePath of policy.filesystem.deny) {
        console.log(`    ${colors.red}-${colors.reset} ${filePath}`);
      }
    }
  }

  if (policy.env) {
    if (policy.env.allow?.length) {
      console.log('  Environment allow:');
      for (const name of policy.env.allow) {
        console.log(`    ${colors.green}+${colors.reset} ${name}`);
      }
    }
    if (policy.env.deny?.length) {
      console.log('  Environment deny:');
      for (const name of policy.env.deny) {
        console.log(`    ${colors.red}-${colors.reset} ${name}`);
      }
    }
  }
}

/**
 * Compare local .localmostrc to cached version.
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

  const cachedPath = path.join(
    getAppDataDirWithoutElectron(),
    'policies',
    repository.replace('/', '_') + '.yml'
  );

  if (!fs.existsSync(cachedPath)) {
    console.log('No cached policy found.');
    console.log(`Local policy: ${path.relative(cwd, localPath)}`);
    return;
  }

  const cachedResult = parseLocalmostrc(cachedPath);
  if (!cachedResult.success || !cachedResult.config) {
    console.log('Cached policy is invalid.');
    return;
  }

  // Compute diff
  const diffs = diffConfigs(cachedResult.config, localResult.config);

  if (diffs.length === 0) {
    console.log(`${colors.green}\u2713${colors.reset} Policy unchanged`);
    return;
  }

  console.log(`${colors.bold}Policy changes:${colors.reset}`);
  console.log();
  console.log(formatPolicyDiff(diffs));
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

  const template: LocalmostrcConfig = {
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
  diff              Compare local vs cached policy
  validate          Validate .localmostrc syntax
  init              Create a new .localmostrc template

${colors.bold}OPTIONS:${colors.reset}
  -w, --workflow <name>  Show effective policy for a specific workflow
  -f, --force            Overwrite existing file (for init)

${colors.bold}EXAMPLES:${colors.reset}
  localmost policy show
  localmost policy show --workflow build
  localmost policy diff
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
