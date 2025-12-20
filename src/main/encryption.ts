/**
 * Encryption helpers for sensitive data using Electron's safeStorage.
 */

import { safeStorage } from 'electron';
import { bootLog } from './log-file';

export const ENCRYPTED_PREFIX = 'encrypted:';

/**
 * Encrypt a string value using Electron's safeStorage.
 * Returns a base64-encoded encrypted string with prefix.
 * Throws an error if encryption is not available (fail-secure).
 */
export const encryptValue = (value: string): string => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Cannot store credentials securely - OS keychain/secret service not available. ' +
      'Please ensure your system has a working keychain (macOS), credential manager (Windows), ' +
      'or secret service (Linux with libsecret/gnome-keyring).'
    );
  }
  const encrypted = safeStorage.encryptString(value);
  return ENCRYPTED_PREFIX + encrypted.toString('base64');
};

/**
 * Decrypt a value that was encrypted with encryptValue.
 * Rejects plaintext values - users must re-authenticate if config is unencrypted.
 */
export const decryptValue = (value: string): string => {
  if (!value.startsWith(ENCRYPTED_PREFIX)) {
    throw new Error(
      'Plaintext credentials are not supported. Please re-authenticate to store credentials securely.'
    );
  }
  if (!safeStorage.isEncryptionAvailable()) {
    bootLog('error', 'safeStorage decryption not available');
    throw new Error('Cannot decrypt credentials - safeStorage not available');
  }
  const encryptedBase64 = value.slice(ENCRYPTED_PREFIX.length);
  const encryptedBuffer = Buffer.from(encryptedBase64, 'base64');
  return safeStorage.decryptString(encryptedBuffer);
};
