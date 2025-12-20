import React, { Component, ErrorInfo, ReactNode } from 'react';
import PageErrorFallback from './PageErrorFallback';

interface PageErrorBoundaryProps {
  children: ReactNode;
  pageName: string;
  onNavigateAway?: () => void;
  alternatePageName?: string;
}

interface PageErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error boundary for individual pages within the app.
 * Unlike the global ErrorBoundary, this allows users to recover by:
 * - Retrying the current page
 * - Navigating to a different page
 *
 * This prevents a single page crash from taking down the entire application.
 */
class PageErrorBoundary extends Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  constructor(props: PageErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<PageErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`PageErrorBoundary caught error in ${this.props.pageName}:`, error, errorInfo);

    // Log to the main process if available
    if (window.localmost?.logs?.write) {
      window.localmost.logs.write({
        timestamp: new Date().toISOString(),
        level: 'error',
        message: `Page Error (${this.props.pageName}): ${error.message}\n${errorInfo.componentStack}`,
      });
    }
  }

  handleRetry = (): void => {
    this.setState({
      hasError: false,
      error: null,
    });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <PageErrorFallback
          pageName={this.props.pageName}
          error={this.state.error}
          onRetry={this.handleRetry}
          onNavigateAway={this.props.onNavigateAway}
          alternatePageName={this.props.alternatePageName}
        />
      );
    }

    return this.props.children;
  }
}

export default PageErrorBoundary;
