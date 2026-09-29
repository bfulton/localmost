/**
 * Security utilities: log sanitization and global error handlers.
 */

/**
 * Sanitize log messages to redact sensitive data like tokens.
 */
export const sanitizeLogMessage = (message: string): string => {
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_ followed by alphanumeric
  // Also matches classic personal access tokens
  let sanitized = message.replace(/\b(gh[pousr]_[A-Za-z0-9_]{36,})\b/g, '[REDACTED_GH_TOKEN]');

  // Fine-grained personal access tokens (github_pat_<22>_<59>), which the
  // prefix rule above does not match.
  sanitized = sanitized.replace(/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '[REDACTED_GH_TOKEN]');

  // A worker's broker key. The /w/<key> prefix is all that separates one
  // worker's broker session from another's, so a logged key is a usable one.
  // Scoped to /w/ so other SHA-256 digests in the log stay readable.
  sanitized = sanitized.replace(/\/w\/[0-9a-fA-F]{64}/g, '/w/[REDACTED]');

  // Credentials in a URL's userinfo: the egress proxy's per-worker token
  // (http://localmost:<token>@...), a token in a git remote, a database
  // password, including one with an empty username (redis://:password@).
  // Only user:password is taken; a bare user@ (git@, ssh://git@) carries no
  // secret and stays readable - which also means a token used as the whole
  // username (https://<token>@github.com) is caught only by the token rules
  // above. A password holding an unencoded '/' or '@' is not a valid URL and
  // may be missed or only partly redacted.
  //
  // The lookbehind, not \b, anchors the scheme: \b would retry at every word
  // boundary inside a long dotted run, each try rescanning the rest of the
  // line, and this runs on the main thread over worker stderr.
  sanitized = sanitized.replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]+@/gi, '$1[REDACTED]@');

  // JWT tokens (eyJ...)
  sanitized = sanitized.replace(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]');

  // GitHub registration tokens (base64-like, typically 29+ chars)
  sanitized = sanitized.replace(/\b[A-Z0-9]{29,}\b/g, '[REDACTED_REG_TOKEN]');

  // Our encrypted values
  sanitized = sanitized.replace(/encrypted:[A-Za-z0-9+/=]+/g, '[REDACTED_ENCRYPTED]');

  // Generic bearer/token patterns in URLs or headers
  sanitized = sanitized.replace(/([?&]token=)[^&\s]+/gi, '$1[REDACTED]');
  sanitized = sanitized.replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]');

  return sanitized;
};

/**
 * Sanitize any value for safe logging (handles objects, errors, etc.)
 */
export const sanitizeForLogging = (value: unknown): string => {
  if (value instanceof Error) {
    return sanitizeLogMessage(`${value.name}: ${value.message}\n${value.stack || ''}`);
  }
  if (typeof value === 'string') {
    return sanitizeLogMessage(value);
  }
  try {
    return sanitizeLogMessage(JSON.stringify(value));
  } catch {
    return sanitizeLogMessage(String(value));
  }
};

/**
 * Install global error handlers to prevent token leakage in uncaught exceptions.
 * Also wraps console methods for comprehensive sanitization.
 */
export const installSecurityHandlers = (): void => {
  // Store original console methods
  const originalConsoleError = console.error.bind(console);
  const originalConsoleWarn = console.warn.bind(console);
  const originalConsoleLog = console.log.bind(console);

  // Wrap console.error to sanitize output
  console.error = (...args: unknown[]) => {
    originalConsoleError(...args.map(sanitizeForLogging));
  };

  // Wrap console.warn to sanitize output
  console.warn = (...args: unknown[]) => {
    originalConsoleWarn(...args.map(sanitizeForLogging));
  };

  // Wrap console.log to sanitize output
  console.log = (...args: unknown[]) => {
    originalConsoleLog(...args.map(sanitizeForLogging));
  };

  // Handle uncaught exceptions
  process.on('uncaughtException', (error: Error) => {
    originalConsoleError('[UNCAUGHT EXCEPTION]', sanitizeForLogging(error));
    // Don't exit - let Electron handle graceful shutdown
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason: unknown) => {
    originalConsoleError('[UNHANDLED REJECTION]', sanitizeForLogging(reason));
  });
};
