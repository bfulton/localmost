import React, { useState, useEffect } from 'react';
import StatusPage from './components/StatusPage';
import SettingsPage from './components/SettingsPage';
import UpdateNotification from './components/UpdateNotification';
import TargetsPage from './components/TargetsPage';
import PageErrorBoundary from './components/PageErrorBoundary';
import { AppConfigProvider, RunnerProvider, UpdateProvider, useAppConfig, useRunner } from './contexts';
import styles from './components/App.module.css';

type View = 'status' | 'settings' | 'targets';

// Re-export ThemeSetting for backward compatibility
export type { ThemeSetting } from './contexts';

const AppContent: React.FC = () => {
  const { isLoading: isConfigLoading, error, isOnline } = useAppConfig();
  const { user, isDownloaded, isConfigured, isInitialLoading: isRunnerLoading } = useRunner();

  const [view, setView] = useState<View>('status');
  const [scrollToSection, setScrollToSection] = useState<string | undefined>();

  // Check if setup is needed and redirect to settings
  // Must wait for BOTH contexts to finish loading before checking setup state
  useEffect(() => {
    const isLoading = isConfigLoading || isRunnerLoading;
    if (!isLoading && (!user || !isDownloaded || !isConfigured)) {
      setView('settings');
    }
  }, [isConfigLoading, isRunnerLoading, user, isDownloaded, isConfigured]);

  // Listen for navigation from menu
  useEffect(() => {
    const unsubNav = window.localmost.app.onNavigate((targetView) => {
      if (targetView === 'settings') {
        setView('settings');
      } else if (targetView === 'status') {
        setView('status');
      }
    });

    return () => {
      unsubNav();
    };
  }, []);

  if (isConfigLoading || isRunnerLoading) {
    return (
      <div className={styles.loadingScreen}>
        <div className={styles.loadingSpinner} />
        <p>Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.loadingScreen}>
        <h2 className={styles.errorHeading}>Error</h2>
        <p className={styles.errorDescription}>{error}</p>
      </div>
    );
  }

  return (
    <>
      <div className={styles.titlebar}>
        <h1>localmost</h1>
      </div>

      {!isOnline && (
        <div className={styles.offlineBanner}>
          <span className={styles.offlineIcon}>○</span>
          <span>You're offline. Some features may be unavailable.</span>
        </div>
      )}

      <UpdateNotification />

      {view === 'status' && (
        <PageErrorBoundary
          key="status-page"
          pageName="Status"
          onNavigateAway={() => setView('settings')}
          alternatePageName="Settings"
        >
          <StatusPage
            onOpenSettings={(section?: string) => {
              setScrollToSection(section);
              setView('settings');
            }}
          />
        </PageErrorBoundary>
      )}

      {view === 'settings' && (
        <PageErrorBoundary
          key="settings-page"
          pageName="Settings"
          onNavigateAway={() => {
            setScrollToSection(undefined);
            setView('status');
          }}
          alternatePageName="Status"
        >
          <SettingsPage
            onBack={() => {
              setScrollToSection(undefined);
              setView('status');
            }}
            scrollToSection={scrollToSection}
            onOpenTargets={() => setView('targets')}
          />
        </PageErrorBoundary>
      )}

      {view === 'targets' && (
        <PageErrorBoundary
          key="targets-page"
          pageName="Targets"
          onNavigateAway={() => setView('settings')}
          alternatePageName="Settings"
        >
          <TargetsPage onBack={() => setView('settings')} />
        </PageErrorBoundary>
      )}
    </>
  );
};

const App: React.FC = () => {
  return (
    <AppConfigProvider>
      <RunnerProvider>
        <UpdateProvider>
          <AppContent />
        </UpdateProvider>
      </RunnerProvider>
    </AppConfigProvider>
  );
};

export default App;
