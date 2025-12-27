/**
 * Secrets Manager
 *
 * Handles secure storage of workflow secrets in macOS Keychain.
 * Secrets are stored per-repository to allow different values for different projects.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getAppDataDirWithoutElectron } from './paths';

// =============================================================================
// Types
// =============================================================================

export interface SecretEntry {
  name: string;
  repository: string;
  createdAt: string;
  updatedAt: string;
}

export type SecretMode = 'stub' | 'prompt' | 'abort';

// =============================================================================
// Constants
// =============================================================================

const KEYCHAIN_SERVICE = 'localmost-secrets';
const SECRETS_INDEX_FILE = 'secrets-index.json';

// =============================================================================
// Keychain Operations
// =============================================================================

/**
 * Store a secret in the macOS Keychain.
 */
export function storeSecret(repository: string, name: string, value: string): void {
  const account = formatKeychainAccount(repository, name);

  // Delete existing if present (security command fails on duplicate)
  try {
    execSync(
      `security delete-generic-password -s "${KEYCHAIN_SERVICE}" -a "${account}" 2>/dev/null`,
      { encoding: 'utf-8' }
    );
  } catch {
    // Ignore errors - secret may not exist
  }

  // Add new secret
  execSync(
    `security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "${account}" -w "${escapeForShell(value)}"`,
    { encoding: 'utf-8' }
  );

  // Update index
  updateSecretsIndex(repository, name);
}

/**
 * Retrieve a secret from the macOS Keychain.
 */
export function getSecret(repository: string, name: string): string | null {
  const account = formatKeychainAccount(repository, name);

  try {
    const result = execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${account}" -w`,
      { encoding: 'utf-8' }
    );
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Delete a secret from the macOS Keychain.
 */
export function deleteSecret(repository: string, name: string): boolean {
  const account = formatKeychainAccount(repository, name);

  try {
    execSync(
      `security delete-generic-password -s "${KEYCHAIN_SERVICE}" -a "${account}"`,
      { encoding: 'utf-8' }
    );
    removeFromSecretsIndex(repository, name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a secret exists.
 */
export function hasSecret(repository: string, name: string): boolean {
  return getSecret(repository, name) !== null;
}

// =============================================================================
// Secret Index Management
// =============================================================================

/**
 * Get the secrets index file path.
 */
function getSecretsIndexPath(): string {
  return path.join(getAppDataDirWithoutElectron(), SECRETS_INDEX_FILE);
}

/**
 * Load the secrets index.
 */
function loadSecretsIndex(): Record<string, SecretEntry[]> {
  const indexPath = getSecretsIndexPath();
  if (!fs.existsSync(indexPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Save the secrets index.
 */
function saveSecretsIndex(index: Record<string, SecretEntry[]>): void {
  const indexPath = getSecretsIndexPath();
  const dir = path.dirname(indexPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

/**
 * Update the secrets index when a secret is stored.
 */
function updateSecretsIndex(repository: string, name: string): void {
  const index = loadSecretsIndex();
  const now = new Date().toISOString();

  if (!index[repository]) {
    index[repository] = [];
  }

  const existing = index[repository].find((s) => s.name === name);
  if (existing) {
    existing.updatedAt = now;
  } else {
    index[repository].push({
      name,
      repository,
      createdAt: now,
      updatedAt: now,
    });
  }

  saveSecretsIndex(index);
}

/**
 * Remove a secret from the index.
 */
function removeFromSecretsIndex(repository: string, name: string): void {
  const index = loadSecretsIndex();
  if (index[repository]) {
    index[repository] = index[repository].filter((s) => s.name !== name);
    if (index[repository].length === 0) {
      delete index[repository];
    }
    saveSecretsIndex(index);
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * List all secrets for a repository.
 */
export function listSecrets(repository: string): SecretEntry[] {
  const index = loadSecretsIndex();
  return index[repository] || [];
}

/**
 * List all repositories with stored secrets.
 */
export function listRepositoriesWithSecrets(): string[] {
  const index = loadSecretsIndex();
  return Object.keys(index);
}

/**
 * Clear all secrets for a repository.
 */
export function clearSecrets(repository: string): number {
  const secrets = listSecrets(repository);
  let deleted = 0;

  for (const secret of secrets) {
    if (deleteSecret(repository, secret.name)) {
      deleted++;
    }
  }

  return deleted;
}

/**
 * Get multiple secrets for a workflow.
 * Returns a map of secret name to value.
 */
export function getSecrets(repository: string, names: string[]): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const name of names) {
    result[name] = getSecret(repository, name);
  }
  return result;
}

/**
 * Store multiple secrets at once.
 */
export function storeSecrets(repository: string, secrets: Record<string, string>): void {
  for (const [name, value] of Object.entries(secrets)) {
    storeSecret(repository, name, value);
  }
}

// =============================================================================
// Interactive Prompting
// =============================================================================

/**
 * Interactive secret prompt for CLI use.
 * Returns the resolved secrets based on user choices.
 */
export async function promptForSecrets(
  repository: string,
  requiredSecrets: string[],
  mode: SecretMode = 'prompt'
): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};

  for (const name of requiredSecrets) {
    // Check if already stored
    const stored = getSecret(repository, name);
    if (stored !== null) {
      secrets[name] = stored;
      continue;
    }

    switch (mode) {
      case 'stub':
        secrets[name] = '';
        break;
      case 'abort':
        throw new Error(`Required secret not found: ${name}`);
      case 'prompt':
        // In a real implementation, this would use readline or similar
        // For now, we'll use a placeholder
        console.log(`Secret ${name} not found. Please set it using:`);
        console.log(`  localmost secrets set ${name} --repo ${repository}`);
        secrets[name] = '';
        break;
    }
  }

  return secrets;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Format the keychain account name.
 */
function formatKeychainAccount(repository: string, secretName: string): string {
  // Use a safe format: repo:secretName
  return `${repository}:${secretName}`;
}

/**
 * Escape a string for shell usage.
 */
function escapeForShell(value: string): string {
  // Escape single quotes and wrap in single quotes
  return value.replace(/'/g, "'\\''");
}

/**
 * Parse a repository from a directory path (git remote origin).
 */
export function getRepositoryFromDir(dir: string): string | null {
  try {
    const result = execSync('git remote get-url origin', {
      cwd: dir,
      encoding: 'utf-8',
    });

    // Parse GitHub URL formats
    const url = result.trim();

    // SSH format: git@github.com:owner/repo.git
    const sshMatch = url.match(/git@github\.com:([^/]+\/[^.]+)(?:\.git)?$/);
    if (sshMatch) {
      return sshMatch[1];
    }

    // HTTPS format: https://github.com/owner/repo.git
    const httpsMatch = url.match(/https:\/\/github\.com\/([^/]+\/[^.]+)(?:\.git)?$/);
    if (httpsMatch) {
      return httpsMatch[1];
    }

    return null;
  } catch {
    return null;
  }
}
