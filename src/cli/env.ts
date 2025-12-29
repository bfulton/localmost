/**
 * CLI Env Command
 *
 * Show local environment information and compare to GitHub runners.
 *
 * Usage:
 *   localmost env                    # Show local environment
 *   localmost env --compare macos-14 # Compare to specific runner
 */

import {
  detectLocalEnvironment,
  compareEnvironments,
  formatEnvironmentInfo,
  formatEnvironmentDiff,
  GITHUB_RUNNER_ENVIRONMENTS,
} from '../shared/environment';

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  yellow: '\x1b[33m',
};

// =============================================================================
// Types
// =============================================================================

export interface EnvOptions {
  /** Runner to compare against */
  compare?: string;
  /** Show available runner labels */
  list?: boolean;
}

// =============================================================================
// CLI Entry Point
// =============================================================================

/**
 * Run the env command.
 */
export function runEnv(options: EnvOptions): void {
  if (options.list) {
    console.log(`${colors.bold}Available GitHub runner labels:${colors.reset}\n`);
    for (const [label, env] of Object.entries(GITHUB_RUNNER_ENVIRONMENTS)) {
      console.log(`  ${label}`);
      console.log(`    macOS ${env.macosVersion}, Xcode ${env.xcodeVersion}, ${env.arch}`);
    }
    console.log();
    console.log(`${colors.dim}Source: https://github.com/actions/runner-images${colors.reset}`);
    return;
  }

  // Detect local environment
  const localEnv = detectLocalEnvironment();
  console.log(formatEnvironmentInfo(localEnv));

  // Compare if requested
  if (options.compare) {
    console.log();
    if (!GITHUB_RUNNER_ENVIRONMENTS[options.compare]) {
      console.log(`${colors.yellow}Unknown runner: ${options.compare}${colors.reset}`);
      console.log('Use --list to see available runners.');
      return;
    }

    console.log(`${colors.bold}Comparing to ${options.compare}:${colors.reset}\n`);
    const diffs = compareEnvironments(localEnv, options.compare);
    console.log(formatEnvironmentDiff(diffs));
  } else {
    // Default comparison to macos-latest
    console.log();
    console.log(`${colors.bold}Comparing to macos-latest:${colors.reset}\n`);
    const diffs = compareEnvironments(localEnv, 'macos-latest');
    console.log(formatEnvironmentDiff(diffs));
  }
}

/**
 * Parse env command arguments.
 */
export function parseEnvArgs(args: string[]): EnvOptions {
  const options: EnvOptions = {};

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--compare' || arg === '-c') {
      options.compare = args[++i];
    } else if (arg === '--list' || arg === '-l') {
      options.list = true;
    }

    i++;
  }

  return options;
}

/**
 * Print env command help.
 */
export function printEnvHelp(): void {
  console.log(`
${colors.bold}localmost env${colors.reset} - Show environment information

${colors.bold}USAGE:${colors.reset}
  localmost env [options]

${colors.bold}OPTIONS:${colors.reset}
  -c, --compare <runner>  Compare to specific GitHub runner
  -l, --list              List available runner labels

${colors.bold}EXAMPLES:${colors.reset}
  localmost env
  localmost env --compare macos-14
  localmost env --list

${colors.bold}PURPOSE:${colors.reset}
  Shows your local development environment and compares it to GitHub-hosted
  runners. This helps identify potential "works locally, fails in CI" issues.
`);
}
