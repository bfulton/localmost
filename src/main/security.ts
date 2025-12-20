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
