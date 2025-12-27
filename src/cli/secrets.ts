/**
 * CLI Secrets Command
 *
 * Manage workflow secrets stored in macOS Keychain.
 *
 * Usage:
 *   localmost secrets list                     # List secrets for current repo
 *   localmost secrets set SECRET_NAME          # Set a secret (prompts for value)
 *   localmost secrets set SECRET_NAME "value"  # Set a secret with value
 *   localmost secrets get SECRET_NAME          # Get a secret value
 *   localmost secrets delete SECRET_NAME       # Delete a secret
 *   localmost secrets clear                    # Clear all secrets for repo
 */

import * as readline from 'readline';
import {
  listSecrets,
  listRepositoriesWithSecrets,
  storeSecret,
  getSecret,
  deleteSecret,
  clearSecrets,
  getRepositoryFromDir,
  SecretEntry,
} from '../shared/secrets';

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

// =============================================================================
// Command Handlers
// =============================================================================

/**
 * List secrets for a repository.
 */
function handleList(repository: string, options: SecretsOptions): void {
  if (options.all) {
    // List all repositories with secrets
    const repos = listRepositoriesWithSecrets();
    if (repos.length === 0) {
      console.log('No secrets stored.');
      return;
    }

    console.log(`${colors.bold}Repositories with secrets:${colors.reset}\n`);
    for (const repo of repos) {
      const secrets = listSecrets(repo);
      console.log(`${repo} (${secrets.length} secrets)`);
      for (const secret of secrets) {
        console.log(`  - ${secret.name}`);
      }
      console.log();
    }
    return;
  }

  const secrets = listSecrets(repository);
  if (secrets.length === 0) {
    console.log(`No secrets stored for ${repository}`);
    return;
  }

  console.log(`${colors.bold}Secrets for ${repository}:${colors.reset}\n`);
  for (const secret of secrets) {
    const age = formatAge(secret.updatedAt);
    console.log(`  ${secret.name} ${colors.dim}(updated ${age})${colors.reset}`);
  }
}

/**
 * Set a secret.
 */
async function handleSet(
  repository: string,
  name: string,
  value?: string
): Promise<void> {
  if (!value) {
    // Prompt for value
    value = await promptForSecret(name);
  }

  storeSecret(repository, name, value);
  console.log(`${colors.green}\u2713${colors.reset} Secret ${name} stored for ${repository}`);
}

/**
 * Get a secret value.
 */
function handleGet(repository: string, name: string): void {
  const value = getSecret(repository, name);
  if (value === null) {
    console.log(`${colors.red}\u2717${colors.reset} Secret ${name} not found`);
    process.exit(1);
  }
  // Output just the value for scripting
  console.log(value);
}

/**
 * Delete a secret.
 */
function handleDelete(repository: string, name: string): void {
  if (deleteSecret(repository, name)) {
    console.log(`${colors.green}\u2713${colors.reset} Secret ${name} deleted`);
  } else {
    console.log(`${colors.red}\u2717${colors.reset} Secret ${name} not found`);
    process.exit(1);
  }
}

/**
 * Clear all secrets for a repository.
 */
async function handleClear(repository: string): Promise<void> {
  const secrets = listSecrets(repository);
  if (secrets.length === 0) {
    console.log(`No secrets to clear for ${repository}`);
    return;
  }

  // Confirm
  const confirmed = await confirm(
    `Delete ${secrets.length} secrets for ${repository}?`
  );
  if (!confirmed) {
    console.log('Cancelled');
    return;
  }

  const count = clearSecrets(repository);
  console.log(`${colors.green}\u2713${colors.reset} Cleared ${count} secrets`);
}

// =============================================================================
// Types
// =============================================================================

export interface SecretsOptions {
  /** Repository to use (default: auto-detect from git) */
  repo?: string;
  /** List all repositories */
  all?: boolean;
}

// =============================================================================
// CLI Entry Point
// =============================================================================

/**
 * Run the secrets command.
 */
export async function runSecrets(
  subcommand: string,
  args: string[],
  options: SecretsOptions
): Promise<void> {
  // Determine repository
  const repository = options.repo || getRepositoryFromDir(process.cwd());
  if (!repository && !options.all) {
    console.error('Could not detect repository. Use --repo to specify.');
    process.exit(1);
  }

  switch (subcommand) {
    case 'list':
    case 'ls':
      handleList(repository || '', options);
      break;

    case 'set':
    case 'add':
      if (args.length < 1) {
        console.error('Usage: localmost secrets set SECRET_NAME [value]');
        process.exit(1);
      }
      await handleSet(repository!, args[0], args[1]);
      break;

    case 'get':
      if (args.length < 1) {
        console.error('Usage: localmost secrets get SECRET_NAME');
        process.exit(1);
      }
      handleGet(repository!, args[0]);
      break;

    case 'delete':
    case 'rm':
    case 'remove':
      if (args.length < 1) {
        console.error('Usage: localmost secrets delete SECRET_NAME');
        process.exit(1);
      }
      handleDelete(repository!, args[0]);
      break;

    case 'clear':
      await handleClear(repository!);
      break;

    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      printSecretsHelp();
      process.exit(1);
  }
}

/**
 * Parse secrets command arguments.
 */
export function parseSecretsArgs(args: string[]): {
  subcommand: string;
  args: string[];
  options: SecretsOptions;
} {
  const options: SecretsOptions = {};
  const remaining: string[] = [];
  let subcommand = 'list';

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--repo' || arg === '-r') {
      options.repo = args[++i];
    } else if (arg === '--all' || arg === '-a') {
      options.all = true;
    } else if (!arg.startsWith('-')) {
      remaining.push(arg);
    }

    i++;
  }

  if (remaining.length > 0) {
    subcommand = remaining[0];
    remaining.shift();
  }

  return { subcommand, args: remaining, options };
}

/**
 * Print secrets command help.
 */
export function printSecretsHelp(): void {
  console.log(`
${colors.bold}localmost secrets${colors.reset} - Manage workflow secrets

${colors.bold}USAGE:${colors.reset}
  localmost secrets <subcommand> [options]

${colors.bold}SUBCOMMANDS:${colors.reset}
  list              List secrets for current repo (default)
  set <name> [value]  Store a secret
  get <name>        Get a secret value
  delete <name>     Delete a secret
  clear             Delete all secrets for current repo

${colors.bold}OPTIONS:${colors.reset}
  -r, --repo <repo>  Repository (default: auto-detect from git)
  -a, --all         List all repositories with secrets

${colors.bold}EXAMPLES:${colors.reset}
  localmost secrets list
  localmost secrets set NPM_TOKEN
  localmost secrets set NPM_TOKEN "my-token-value"
  localmost secrets get NPM_TOKEN
  localmost secrets delete NPM_TOKEN
  localmost secrets clear

${colors.bold}NOTES:${colors.reset}
  Secrets are stored securely in macOS Keychain, encrypted at rest.
  Each secret is scoped to a specific repository.
`);
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Prompt for a secret value with hidden input.
 */
function promptForSecret(name: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Disable echo
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    process.stdout.write(`Enter value for ${name}: `);

    let value = '';
    process.stdin.on('data', (char) => {
      const str = char.toString();
      if (str === '\n' || str === '\r') {
        process.stdout.write('\n');
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        rl.close();
        resolve(value);
      } else if (str === '\u0003') {
        // Ctrl+C
        process.stdout.write('\n');
        process.exit(0);
      } else if (str === '\u007f') {
        // Backspace
        if (value.length > 0) {
          value = value.slice(0, -1);
        }
      } else {
        value += str;
      }
    });
  });
}

/**
 * Prompt for confirmation.
 */
function confirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

/**
 * Format age of a timestamp.
 */
function formatAge(isoString: string): string {
  const date = new Date(isoString);
  const now = Date.now();
  const diff = now - date.getTime();

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
