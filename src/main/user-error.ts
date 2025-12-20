/**
 * User-friendly error handling utility.
 *
 * Maps technical errors to user-friendly messages while preserving
 * technical details for logging. Shows friendly messages in the UI
 * while developers can still see full details in the log panel.
 */

import { GitHubClientError } from './github-client';

/**
 * Result of processing an error for user display.
 */
export interface UserError {
  /** User-friendly message to display in UI */
  userMessage: string;
  /** Technical details for logging */
  technicalDetails: string;
}

/**
 * Map of HTTP status codes to user-friendly messages.
 */
const HTTP_STATUS_MESSAGES: Record<number, string> = {
  400: 'Invalid request. Please try again.',
  401: 'Your session has expired. Please sign in again.',
  403: 'Access denied. Please check your permissions.',
  404: 'The requested resource was not found.',
  408: 'Request timed out. Please try again.',
  422: 'Invalid data. Please check your input and try again.',
  429: 'Too many requests. Please wait a moment and try again.',
  500: 'GitHub is experiencing issues. Please try again later.',
  502: 'GitHub is temporarily unavailable. Please try again later.',
  503: 'GitHub is temporarily unavailable. Please try again later.',
  504: 'Request timed out. Please try again.',
};

/**
 * Patterns to match in error messages and their user-friendly replacements.
 */
const ERROR_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  // Network errors
  { pattern: /ENOTFOUND|ECONNREFUSED|ECONNRESET/i, message: 'Unable to connect. Please check your internet connection.' },
  { pattern: /ETIMEDOUT|ESOCKETTIMEDOUT/i, message: 'Connection timed out. Please try again.' },
  { pattern: /CERT_|SSL_|UNABLE_TO_VERIFY/i, message: 'Secure connection failed. Please check your network settings.' },
  { pattern: /network|offline/i, message: 'Network error. Please check your internet connection.' },

  // File system errors
  { pattern: /EACCES/i, message: 'Permission denied. Please check folder permissions.' },
  { pattern: /ENOENT/i, message: 'File or folder not found.' },
  { pattern: /ENOSPC/i, message: 'Not enough disk space. Please free up some space and try again.' },
  { pattern: /EEXIST/i, message: 'File already exists.' },
  { pattern: /EPERM/i, message: 'Operation not permitted. Please check your permissions.' },

  // Auth errors
  { pattern: /authorization_pending/i, message: 'Waiting for authorization...' },
  { pattern: /expired_token|token.*expired/i, message: 'Authentication timed out. Please try again.' },
  { pattern: /access_denied|user.*cancelled/i, message: 'Authorization was cancelled.' },
  { pattern: /invalid.*token|bad.*credentials/i, message: 'Invalid credentials. Please sign in again.' },

  // Runner errors
  { pattern: /already.*configured|runner.*exists/i, message: 'Runner is already configured for this target.' },
  { pattern: /runner.*not.*found/i, message: 'Runner not found. It may have been removed.' },
  { pattern: /registration.*token/i, message: 'Failed to get runner registration. Please check your permissions.' },
];

/**
 * Process an error and return user-friendly message with technical details.
 *
 * @param error - The error to process
 * @param context - Optional context about what operation failed (e.g., "Authentication", "Download")
 * @returns UserError with userMessage for UI and technicalDetails for logging
 *
 * @example
 * ```typescript
 * try {
 *   await authenticate();
 * } catch (error) {
 *   const { userMessage, technicalDetails } = toUserError(error, 'Authentication');
 *   logger.error(technicalDetails);
 *   return { success: false, error: userMessage };
 * }
 * ```
 */
export function toUserError(error: unknown, context?: string): UserError {
  const prefix = context ? `${context} failed` : 'Operation failed';

  // Handle GitHubClientError with status codes
  if (error instanceof GitHubClientError) {
    const statusMessage = HTTP_STATUS_MESSAGES[error.status];
    const technicalDetails = `${prefix}: ${error.message} (HTTP ${error.status})`;

    if (statusMessage) {
      return {
        userMessage: `${prefix}. ${statusMessage}`,
        technicalDetails,
      };
    }

    return {
      userMessage: `${prefix}. Please try again.`,
      technicalDetails,
    };
  }

  // Handle standard errors
  if (error instanceof Error) {
    const message = error.message;
    const technicalDetails = `${prefix}: ${message}`;

    // Check for HTTP status in error message (e.g., "Failed to fetch: 401")
    const statusMatch = message.match(/\b(4\d{2}|5\d{2})\b/);
    if (statusMatch) {
      const status = parseInt(statusMatch[1], 10);
      const statusMessage = HTTP_STATUS_MESSAGES[status];
      if (statusMessage) {
        return {
          userMessage: `${prefix}. ${statusMessage}`,
          technicalDetails,
        };
      }
    }

    // Check for known error patterns
    for (const { pattern, message: userMsg } of ERROR_PATTERNS) {
      if (pattern.test(message)) {
        return {
          userMessage: `${prefix}. ${userMsg}`,
          technicalDetails,
        };
      }
    }

    // Generic fallback - don't expose raw technical message
    return {
      userMessage: `${prefix}. Please try again or check the logs for details.`,
      technicalDetails,
    };
  }

  // Handle non-Error thrown values
  const technicalDetails = `${prefix}: ${String(error)}`;
  return {
    userMessage: `${prefix}. Please try again.`,
    technicalDetails,
  };
}

/**
 * Get just the user-friendly message from an error.
 * Convenience wrapper around toUserError for simple cases.
 */
export function getUserMessage(error: unknown, context?: string): string {
  return toUserError(error, context).userMessage;
}

/**
 * Get just the technical details from an error.
 * Convenience wrapper around toUserError for logging.
 */
export function getTechnicalDetails(error: unknown, context?: string): string {
  return toUserError(error, context).technicalDetails;
}
