import React, { Component, ErrorInfo, ReactNode } from 'react';
import styles from './ErrorBoundary.module.css';
import shared from '../styles/shared.module.css';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * Error boundary component that catches JavaScript errors anywhere in the child
 * component tree, logs them, and displays a fallback UI instead of crashing.
 *
 * Usage:
 * ```tsx
 * <ErrorBoundary>
 *   <MyComponent />
 * </ErrorBoundary>
 * ```
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log the error to the console
    console.error('ErrorBoundary caught an error:', error, errorInfo);

    // Store error info for display
    this.setState({ errorInfo });

    // Log to the main process if available
    if (window.localmost?.logs?.write) {
      window.localmost.logs.write({
        timestamp: new Date().toISOString(),
        level: 'error',
        message: `UI Error: ${error.message}\n${errorInfo.componentStack}`,
      });
    }
  }

  handleReload = (): void => {
    window.location.reload();
  };

  handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      // Custom fallback provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default fallback UI
      return (
        <div className={styles.errorBoundary}>
          <div className={styles.content}>
            <h2>Something went wrong</h2>
            <p>An unexpected error occurred in the application.</p>

            {this.state.error && (
              <details className={styles.details}>
                <summary>Technical details (for developers)</summary>
                <pre>{this.state.error.message}</pre>
                {this.state.errorInfo && (
                  <pre className={styles.errorStack}>
                    {this.state.errorInfo.componentStack}
                  </pre>
                )}
              </details>
            )}

            <div className={styles.actions}>
              <button className={shared.btnPrimary} onClick={this.handleReload}>
                Reload Application
              </button>
              <button className={shared.btnSecondary} onClick={this.handleReset}>
                Try Again
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
