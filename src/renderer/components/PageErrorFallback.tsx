import React from 'react';
import styles from './PageErrorFallback.module.css';
import shared from '../styles/shared.module.css';

interface PageErrorFallbackProps {
  pageName: string;
  error: Error | null;
  onRetry: () => void;
  onNavigateAway?: () => void;
  alternatePageName?: string;
}

/**
 * Fallback UI for page-level error boundaries.
 * Provides recovery options specific to the failed page context.
 */
const PageErrorFallback: React.FC<PageErrorFallbackProps> = ({
  pageName,
  error,
  onRetry,
  onNavigateAway,
  alternatePageName,
}) => {
  return (
    <div className={styles.pageErrorFallback}>
      <div className={styles.content}>
        <div className={styles.icon}>⚠</div>
        <h2>Unable to load {pageName}</h2>
        <p>
          Something went wrong while displaying this page. You can try again or
          {alternatePageName ? ` go to ${alternatePageName}` : ' reload the application'}.
        </p>

        {error && (
          <details className={styles.details}>
            <summary>Technical details</summary>
            <pre>{error.message}</pre>
          </details>
        )}

        <div className={styles.actions}>
          <button className={shared.btnPrimary} onClick={onRetry}>
            Try Again
          </button>
          {onNavigateAway && alternatePageName && (
            <button className={shared.btnSecondary} onClick={onNavigateAway}>
              Go to {alternatePageName}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PageErrorFallback;
