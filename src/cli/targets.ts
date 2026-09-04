/**
 * CLI Targets Command
 *
 * Manage the repos/orgs this machine runs jobs for.
 *
 * Usage:
 *   localmost targets                      # List targets
 *   localmost targets add <owner>/<repo>   # Register runners for a repo
 *   localmost targets add <owner> --org    # Register runners for an org
 *   localmost targets remove <ref> [--yes] # Unregister runners
 *   localmost targets enable <ref>         # Accept jobs for a target
 *   localmost targets disable <ref>        # Stop accepting jobs for a target
 */

import * as readline from 'readline';
import type { CliRequest, CliResponse, TargetSummary } from '../shared/cli-protocol';

export type { TargetSummary };

const SUBCOMMANDS = ['list', 'add', 'remove', 'enable', 'disable'];

export interface TargetsOptions {
  /** Skip the confirmation prompt on destructive subcommands. */
  yes?: boolean;
  /** Emit machine-readable JSON instead of formatted text. */
  json?: boolean;
  /** Treat the ref as an organization rather than a repo. */
  org?: boolean;
}

export interface TargetRef {
  type: 'repo' | 'org';
  owner: string;
  repo?: string;
}

/**
 * Parse `localmost targets` arguments into a subcommand, an optional target
 * reference, and flags.
 */
export function parseTargetsArgs(args: string[]): {
  subcommand: string;
  ref?: string;
  options: TargetsOptions;
} {
  const options: TargetsOptions = {};
  const positionals: string[] = [];

  for (const arg of args) {
    if (arg === '--yes' || arg === '-y') {
      options.yes = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--org') {
      options.org = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  const subcommand = positionals[0] || 'list';

  if (!SUBCOMMANDS.includes(subcommand)) {
    throw new Error(`Unknown subcommand: ${subcommand}`);
  }

  if (positionals.length > 2) {
    throw new Error(`Too many arguments: ${positionals.slice(2).join(' ')}`);
  }

  return { subcommand, ref: positionals[1], options };
}

/**
 * Parse a target reference (`owner/repo`, or a bare `owner` with --org).
 */
export function parseTargetRef(ref: string, options: TargetsOptions): TargetRef {
  const parts = (ref || '').split('/');

  if (!ref || parts.length > 2 || parts.some(part => !part)) {
    throw new Error(`Invalid target: "${ref}" (expected owner/repo)`);
  }

  if (parts.length === 1) {
    if (!options.org) {
      throw new Error(`Invalid target: "${ref}" (expected owner/repo, or --org for an organization)`);
    }
    return { type: 'org', owner: parts[0] };
  }

  if (options.org) {
    throw new Error(`--org expects a bare owner, not "${ref}"`);
  }

  return { type: 'repo', owner: parts[0], repo: parts[1] };
}

// =============================================================================
// Output formatting
// =============================================================================

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

/** What happened to a target, for mutation output. */
export type TargetAction = 'added' | 'removed' | 'enabled' | 'disabled';

/**
 * Describe the runner proxies registered for a target, e.g.
 * "4 runners (localmost.host.owner-repo.1-4)".
 */
function describeRunners(target: TargetSummary): string {
  if (target.runnerCount === 0) {
    return 'no runners registered';
  }
  const range = target.runnerCount === 1 ? '.1' : `.1-${target.runnerCount}`;
  const plural = target.runnerCount === 1 ? 'runner' : 'runners';
  return `${target.runnerCount} ${plural} (${target.proxyRunnerName}${range})`;
}

/**
 * Format the target list for humans, or as JSON with --json.
 */
export function formatTargets(targets: TargetSummary[], options: TargetsOptions): string {
  if (options.json) {
    return JSON.stringify(targets, null, 2);
  }

  if (targets.length === 0) {
    return '\nNo targets configured.\n\nAdd one with:\n  localmost targets add <owner>/<repo>\n';
  }

  const lines = [`\n${colors.bold}Targets (${targets.length}):${colors.reset}\n`];

  for (const target of targets) {
    const icon = target.enabled ? `${colors.green}✓${colors.reset}` : `${colors.dim}○${colors.reset}`;
    const suffix = target.enabled ? '' : ` ${colors.yellow}(disabled)${colors.reset}`;
    lines.push(`  ${icon} ${target.displayName}${suffix}`);
    lines.push(`      Runners:  ${describeRunners(target)}`);
    lines.push(`      Added:    ${new Date(target.addedAt).toLocaleString()}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format the result of an add/remove/enable/disable for humans, or as JSON
 * with --json.
 */
export function formatMutation(
  action: TargetAction,
  target: TargetSummary,
  options: TargetsOptions
): string {
  if (options.json) {
    return JSON.stringify({ action, target }, null, 2);
  }

  const verb = action.charAt(0).toUpperCase() + action.slice(1);
  const lines = [`${colors.green}✓${colors.reset} ${verb} ${target.displayName}`];

  if (action === 'added') {
    lines.push(`  ${describeRunners(target)}`);
  } else if (action === 'removed') {
    lines.push(`  ${describeRunners(target)} unregistered`);
  }

  return lines.join('\n');
}

// =============================================================================
// Command execution
// =============================================================================

/** Everything `runTargets` touches outside itself, injected for testability. */
export interface TargetsDeps {
  /** Send a request to the running app and await its response. */
  send: (request: CliRequest) => Promise<CliResponse>;
  io: {
    /** Whether stdin is an interactive terminal. */
    isTTY: boolean;
    /** Ask the user a question and resolve with their answer. */
    prompt: (question: string) => Promise<string>;
  };
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * Find a target summary by display name or id, case-insensitively.
 */
export function findSummaryByRef(
  targets: TargetSummary[],
  ref: string
): TargetSummary | undefined {
  const needle = ref.trim().toLowerCase();
  if (!needle) return undefined;

  return targets.find(
    t => t.id.toLowerCase() === needle || t.displayName.toLowerCase() === needle
  );
}

/** Read a line from stdin, for confirmation prompts. */
export function createPrompt(): (question: string) => Promise<string> {
  return (question: string) =>
    new Promise(resolve => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, answer => {
        rl.close();
        resolve(answer);
      });
    });
}

const MISSING_REF = 'Missing target: expected owner/repo (or --org <owner> for an organization)';

/**
 * Run a targets subcommand. Returns the process exit code.
 */
export async function runTargets(
  subcommand: string,
  ref: string | undefined,
  options: TargetsOptions,
  deps: TargetsDeps
): Promise<number> {
  const fail = (message: string): number => {
    deps.err(options.json ? JSON.stringify({ error: message }, null, 2) : `Error: ${message}`);
    return 1;
  };

  /** Fetch the target list, or null after reporting the failure. */
  const fetchTargets = async (): Promise<TargetSummary[] | null> => {
    const response = await deps.send({ command: 'targets-list' });
    if (!response.success) {
      fail(response.error);
      return null;
    }
    if (response.command !== 'targets-list') {
      fail('Unexpected response from app');
      return null;
    }
    return response.data.targets;
  };

  switch (subcommand) {
    case 'list': {
      const targets = await fetchTargets();
      if (!targets) return 1;

      deps.out(formatTargets(targets, options));
      return 0;
    }

    case 'add': {
      if (!ref) return fail(MISSING_REF);

      let parsed: TargetRef;
      try {
        parsed = parseTargetRef(ref, options);
      } catch (err) {
        return fail((err as Error).message);
      }

      const args =
        parsed.type === 'org'
          ? { type: parsed.type, owner: parsed.owner }
          : { type: parsed.type, owner: parsed.owner, repo: parsed.repo };

      if (!options.json) {
        deps.out(`Registering runners for ${parsed.type === 'org' ? parsed.owner : ref}...`);
      }

      const response = await deps.send({ command: 'targets-add', args });
      if (!response.success) return fail(response.error);
      if (response.command !== 'targets-add') return fail('Unexpected response from app');

      deps.out(formatMutation('added', response.data.target, options));
      return 0;
    }

    case 'remove': {
      if (!ref) return fail(MISSING_REF);

      const targets = await fetchTargets();
      if (!targets) return 1;

      const target = findSummaryByRef(targets, ref);
      if (!target) return fail(`No target matching "${ref}"`);

      if (!options.yes) {
        if (!deps.io.isTTY) {
          return fail(`Refusing to remove ${target.displayName} without --yes (not a terminal)`);
        }

        const answer = await deps.io.prompt(
          `Remove ${target.displayName}?\n` +
            `This unregisters ${describeRunners(target)} from GitHub.\n` +
            'Continue? [y/N] '
        );

        if (!/^y(es)?$/i.test(answer.trim())) {
          return fail('Aborted.');
        }
      }

      const response = await deps.send({ command: 'targets-remove', args: { ref } });
      if (!response.success) return fail(response.error);
      if (response.command !== 'targets-remove') return fail('Unexpected response from app');

      deps.out(formatMutation('removed', response.data.target, options));
      return 0;
    }

    case 'enable':
    case 'disable': {
      if (!ref) return fail(MISSING_REF);

      const enabled = subcommand === 'enable';
      const response = await deps.send({ command: 'targets-update', args: { ref, enabled } });
      if (!response.success) return fail(response.error);
      if (response.command !== 'targets-update') return fail('Unexpected response from app');

      deps.out(formatMutation(enabled ? 'enabled' : 'disabled', response.data.target, options));
      return 0;
    }

    default:
      return fail(`Unknown subcommand: ${subcommand}`);
  }
}

/**
 * Print targets command help.
 */
export function printTargetsHelp(): void {
  console.log(`
${colors.bold}localmost targets${colors.reset} - Manage the repos/orgs this machine runs jobs for

${colors.bold}USAGE:${colors.reset}
  localmost targets <subcommand> [target] [options]

${colors.bold}SUBCOMMANDS:${colors.reset}
  list              List configured targets (default)
  add <target>      Register runners with GitHub for a target
  remove <target>   Unregister a target's runners and forget it
  enable <target>   Start accepting jobs for a target
  disable <target>  Stop accepting jobs for a target

${colors.bold}TARGETS:${colors.reset}
  owner/repo        A repository
  owner --org       An organization
  <id>              A target id, as shown by "localmost targets list"

${colors.bold}OPTIONS:${colors.reset}
  --org             Treat the target as an organization
  -y, --yes         Skip the confirmation prompt when removing
  --json            Output JSON instead of formatted text

${colors.bold}EXAMPLES:${colors.reset}
  localmost targets
  localmost targets add bfulton/voight-kampff
  localmost targets add my-org --org
  localmost targets disable bfulton/supdb
  localmost targets remove bfulton/supdb --yes
  localmost targets list --json

${colors.dim}Adding a target registers one runner per concurrent job slot with GitHub.
Removing it unregisters them; re-adding mints new runner IDs.${colors.reset}
`);
}
