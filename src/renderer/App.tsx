import React, { useState, useEffect } from 'react';
import StatusPage from './components/StatusPage';
import SettingsPage from './components/SettingsPage';
import UpdateNotification from './components/UpdateNotification';
import PageErrorBoundary from './components/PageErrorBoundary';
import { AppConfigProvider, RunnerProvider, UpdateProvider, useAppConfig, useRunner } from './contexts';
import styles from './components/App.module.css';

type View = 'status' | 'settings';

// Re-export ThemeSetting for backward compatibility
export type { ThemeSetting } from './contexts';

const AppContent: React.FC = () => {
  const { isLoading, error, isOnline } = useAppConfig();
  const { user, isDownloaded, isConfigured } = useRunner();

  const [view, setView] = useState<View>('status');
  const [scrollToSection, setScrollToSection] = useState<string | undefined>();

  // Check if setup is needed and redirect to settings
  useEffect(() => {
    if (!isLoading && (!user || !isDownloaded || !isConfigured)) {
      setView('settings');
    }
  }, [isLoading, user, isDownloaded, isConfigured]);

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

  if (isLoading) {
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
          />
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
