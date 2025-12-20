import { LogEntry } from '../shared/types';

/**
 * Log entry callback type for sending logs to UI and file.
 */
export type LogSink = (entry: LogEntry) => void;

/**
 * Logger class providing a clean interface for logging with automatic timestamps.
 *
 * Usage:
 * ```typescript
 * const logger = new Logger(sendLog);
 * logger.info('Starting runner...');
 * logger.warn('Token expires soon');
 * logger.error('Failed to connect');
 * ```
 */
export class Logger {
  private sink: LogSink;
  private prefix: string;

  constructor(sink: LogSink, prefix?: string) {
    this.sink = sink;
    this.prefix = prefix || '';
  }

  /**
   * Create a child logger with a prefix.
   */
  child(prefix: string): Logger {
    const fullPrefix = this.prefix ? `${this.prefix}:${prefix}` : prefix;
    return new Logger(this.sink, fullPrefix);
  }

  /**
   * Format message with optional prefix.
   */
  private formatMessage(message: string): string {
    return this.prefix ? `[${this.prefix}] ${message}` : message;
  }

  /**
   * Log an info message.
   */
  info(message: string): void {
    this.sink({
      timestamp: new Date().toISOString(),
      level: 'info',
      message: this.formatMessage(message),
    });
  }

  /**
   * Log a warning message.
   */
  warn(message: string): void {
    this.sink({
      timestamp: new Date().toISOString(),
      level: 'warn',
      message: this.formatMessage(message),
    });
  }

  /**
   * Log an error message.
   */
  error(message: string): void;
  error(message: string, error: unknown): void;
  error(message: string, error?: unknown): void {
    let fullMessage = message;
    if (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      fullMessage = `${message}: ${errorMessage}`;
    }
    this.sink({
      timestamp: new Date().toISOString(),
      level: 'error',
      message: this.formatMessage(fullMessage),
    });
  }

  /**
   * Log a debug message (only in development).
   */
  debug(message: string): void {
    if (process.env.NODE_ENV === 'development') {
      this.sink({
        timestamp: new Date().toISOString(),
        level: 'debug',
        message: this.formatMessage(message),
      });
    }
  }
}

/**
 * Create a logger factory function that can be used to create loggers
 * with a shared sink.
 */
export const createLoggerFactory = (sink: LogSink) => {
  return (prefix?: string): Logger => new Logger(sink, prefix);
};
