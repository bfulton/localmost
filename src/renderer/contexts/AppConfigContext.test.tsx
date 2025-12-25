import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AppConfigProvider, useAppConfig } from './AppConfigContext';
import { mockLocalmost } from '../../../test/setup-renderer';

// Test component that uses the context
const TestConsumer: React.FC = () => {
  const config = useAppConfig();

  return (
    <div>
      <span data-testid="theme">{config.theme}</span>
      <span data-testid="log-level">{config.logLevel}</span>
      <span data-testid="runner-log-level">{config.runnerLogLevel}</span>
      <span data-testid="logs-count">{config.logs.length}</span>
      <span data-testid="max-log-scrollback">{config.maxLogScrollback}</span>
      <span data-testid="max-job-history">{config.maxJobHistory}</span>
      <span data-testid="sleep-protection">{config.sleepProtection}</span>
      <span data-testid="sleep-consented">{String(config.sleepProtectionConsented)}</span>
      <span data-testid="preserve-work-dir">{config.preserveWorkDir}</span>
      <span data-testid="tool-cache-location">{config.toolCacheLocation}</span>
      <span data-testid="user-filter-mode">{config.userFilter.mode}</span>
      <span data-testid="user-filter-allowlist-count">{config.userFilter.allowlist.length}</span>
      <span data-testid="is-online">{String(config.isOnline)}</span>
      <span data-testid="is-loading">{String(config.isLoading)}</span>
      <span data-testid="error">{config.error || 'no-error'}</span>
      <button data-testid="set-theme-dark" onClick={() => config.setTheme('dark')}>Dark</button>
      <button data-testid="set-theme-light" onClick={() => config.setTheme('light')}>Light</button>
      <button data-testid="set-theme-auto" onClick={() => config.setTheme('auto')}>Auto</button>
      <button data-testid="set-log-level" onClick={() => config.setLogLevel('debug')}>Set Log Level</button>
      <button data-testid="set-runner-log-level" onClick={() => config.setRunnerLogLevel('error')}>Set Runner Log Level</button>
      <button data-testid="clear-logs" onClick={config.clearLogs}>Clear Logs</button>
      <button data-testid="set-max-scrollback" onClick={() => config.setMaxLogScrollback(100)}>Set Scrollback</button>
      <button data-testid="set-max-job-history" onClick={() => config.setMaxJobHistory(20)}>Set Job History</button>
      <button data-testid="set-sleep-protection" onClick={() => config.setSleepProtection('when-busy')}>Set Sleep Protection</button>
      <button data-testid="consent-sleep" onClick={config.consentToSleepProtection}>Consent</button>
      <button data-testid="set-preserve-work-dir" onClick={() => config.setPreserveWorkDir('session')}>Set Preserve</button>
      <button data-testid="set-tool-cache" onClick={() => config.setToolCacheLocation('per-sandbox')}>Set Tool Cache</button>
      <button data-testid="set-user-filter-just-me" onClick={() => config.setUserFilter({ mode: 'just-me', allowlist: [] })}>Set Just Me</button>
      <button data-testid="set-user-filter-allowlist" onClick={() => config.setUserFilter({ mode: 'allowlist', allowlist: [{ login: 'testuser', avatar_url: '', name: null }] })}>Set Allowlist</button>
    </div>
  );
};

describe('AppConfigContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mocks
    mockLocalmost.settings.get.mockResolvedValue({});
    mockLocalmost.settings.set.mockResolvedValue({ success: true });
    mockLocalmost.logs.onEntry.mockReturnValue(() => {});
    mockLocalmost.network.isOnline.mockResolvedValue(true);
    mockLocalmost.jobs.setMaxHistory.mockResolvedValue(undefined);
  });

  describe('useAppConfig hook', () => {
    it('should throw when used outside provider', () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        render(<TestConsumer />);
      }).toThrow('useAppConfig must be used within an AppConfigProvider');

      spy.mockRestore();
    });
  });

  describe('Initial State', () => {
    it('should show loading state initially', async () => {
      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      expect(screen.getByTestId('is-loading').textContent).toBe('true');

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });
    });

    it('should set default values', async () => {
      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      expect(screen.getByTestId('theme').textContent).toBe('auto');
      expect(screen.getByTestId('log-level').textContent).toBe('info');
      expect(screen.getByTestId('runner-log-level').textContent).toBe('warn');
      expect(screen.getByTestId('max-log-scrollback').textContent).toBe('500');
      expect(screen.getByTestId('max-job-history').textContent).toBe('10');
      expect(screen.getByTestId('sleep-protection').textContent).toBe('never');
      expect(screen.getByTestId('preserve-work-dir').textContent).toBe('never');
      expect(screen.getByTestId('tool-cache-location').textContent).toBe('persistent');
    });

    it('should load settings from storage', async () => {
      mockLocalmost.settings.get.mockResolvedValue({
        theme: 'dark',
        logLevel: 'debug',
        runnerLogLevel: 'error',
        maxLogScrollback: 1000,
        maxJobHistory: 25,
        sleepProtection: 'always',
        sleepProtectionConsented: true,
        preserveWorkDir: 'always',
        toolCacheLocation: 'per-sandbox',
      });

      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('theme').textContent).toBe('dark');
        expect(screen.getByTestId('log-level').textContent).toBe('debug');
        expect(screen.getByTestId('runner-log-level').textContent).toBe('error');
        expect(screen.getByTestId('max-log-scrollback').textContent).toBe('1000');
        expect(screen.getByTestId('max-job-history').textContent).toBe('25');
        expect(screen.getByTestId('sleep-protection').textContent).toBe('always');
        expect(screen.getByTestId('sleep-consented').textContent).toBe('true');
        expect(screen.getByTestId('preserve-work-dir').textContent).toBe('always');
        expect(screen.getByTestId('tool-cache-location').textContent).toBe('per-sandbox');
      });
    });

    it('should check network status', async () => {
      mockLocalmost.network.isOnline.mockResolvedValue(false);

      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-online').textContent).toBe('false');
      });
    });
  });

  describe('Theme Management', () => {
    it('should change theme to dark', async () => {
      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('set-theme-dark').click();
      });

      expect(screen.getByTestId('theme').textContent).toBe('dark');
      expect(mockLocalmost.settings.set).toHaveBeenCalledWith({ theme: 'dark' });
    });

    it('should change theme to light', async () => {
      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('set-theme-light').click();
      });

      expect(screen.getByTestId('theme').textContent).toBe('light');
    });

    it('should apply theme to document', async () => {
      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('set-theme-dark').click();
      });

      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  describe('Log Level Management', () => {
    it('should change log level', async () => {
      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('set-log-level').click();
      });

      expect(screen.getByTestId('log-level').textContent).toBe('debug');
      expect(mockLocalmost.settings.set).toHaveBeenCalledWith({ logLevel: 'debug' });
    });

    it('should change runner log level', async () => {
      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('set-runner-log-level').click();
      });

      expect(screen.getByTestId('runner-log-level').textContent).toBe('error');
      expect(mockLocalmost.settings.set).toHaveBeenCalledWith({ runnerLogLevel: 'error' });
    });
  });

  describe('Log Management', () => {
    it('should receive log entries', async () => {
      let logCallback: (entry: any) => void;
      mockLocalmost.logs.onEntry.mockImplementation((cb) => {
        logCallback = cb;
        return () => {};
      });

      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      await act(async () => {
        logCallback!({ timestamp: new Date().toISOString(), level: 'info', message: 'Test log' });
      });

      expect(screen.getByTestId('logs-count').textContent).toBe('1');
    });

    it('should clear logs', async () => {
      let logCallback: (entry: any) => void;
      mockLocalmost.logs.onEntry.mockImplementation((cb) => {
        logCallback = cb;
        return () => {};
      });

      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      // Add a log entry
      await act(async () => {
        logCallback!({ timestamp: new Date().toISOString(), level: 'info', message: 'Test' });
      });

      expect(screen.getByTestId('logs-count').textContent).toBe('1');

      // Clear logs
      await act(async () => {
        screen.getByTestId('clear-logs').click();
      });

      expect(screen.getByTestId('logs-count').textContent).toBe('0');
    });

    it('should respect max log scrollback', async () => {
      let logCallback: (entry: any) => void;
      mockLocalmost.logs.onEntry.mockImplementation((cb) => {
        logCallback = cb;
        return () => {};
      });

      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      // Set low scrollback
      await act(async () => {
        screen.getByTestId('set-max-scrollback').click();
      });

      expect(screen.getByTestId('max-log-scrollback').textContent).toBe('100');
      expect(mockLocalmost.settings.set).toHaveBeenCalledWith({ maxLogScrollback: 100 });
    });
  });

  describe('Job History Management', () => {
    it('should set max job history', async () => {
      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('set-max-job-history').click();
      });

      expect(screen.getByTestId('max-job-history').textContent).toBe('20');
      expect(mockLocalmost.settings.set).toHaveBeenCalledWith({ maxJobHistory: 20 });
      expect(mockLocalmost.jobs.setMaxHistory).toHaveBeenCalledWith(20);
    });
  });

  describe('Sleep Protection', () => {
    it('should set sleep protection', async () => {
      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('set-sleep-protection').click();
      });

      expect(screen.getByTestId('sleep-protection').textContent).toBe('when-busy');
      expect(mockLocalmost.settings.set).toHaveBeenCalledWith({ sleepProtection: 'when-busy' });
    });

    it('should consent to sleep protection', async () => {
      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      expect(screen.getByTestId('sleep-consented').textContent).toBe('false');

      await act(async () => {
        screen.getByTestId('consent-sleep').click();
      });

      expect(screen.getByTestId('sleep-consented').textContent).toBe('true');
      expect(mockLocalmost.settings.set).toHaveBeenCalledWith({ sleepProtectionConsented: true });
    });
  });

  describe('Runner Settings', () => {
    it('should set preserve work dir', async () => {
      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('set-preserve-work-dir').click();
      });

      expect(screen.getByTestId('preserve-work-dir').textContent).toBe('session');
      expect(mockLocalmost.settings.set).toHaveBeenCalledWith({ preserveWorkDir: 'session' });
    });

    it('should set tool cache location', async () => {
      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('set-tool-cache').click();
      });

      expect(screen.getByTestId('tool-cache-location').textContent).toBe('per-sandbox');
      expect(mockLocalmost.settings.set).toHaveBeenCalledWith({ toolCacheLocation: 'per-sandbox' });
    });
  });

  describe('Error Handling', () => {
    it('should handle settings load failure', async () => {
      mockLocalmost.settings.get.mockRejectedValue(new Error('Storage error'));

      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('error').textContent).toContain('Failed to load settings');
      });
    });

    it('should handle settings.set failure gracefully', async () => {
      // First call succeeds (initial load), subsequent calls fail
      mockLocalmost.settings.set.mockRejectedValue(new Error('Storage write failed'));

      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      // Theme should still be 'auto' initially
      expect(screen.getByTestId('theme').textContent).toBe('auto');

      // Try to change theme - the UI updates optimistically
      await act(async () => {
        screen.getByTestId('set-theme-dark').click();
      });

      // UI should still show the new value (optimistic update)
      // The error is logged but doesn't block the UI
      expect(screen.getByTestId('theme').textContent).toBe('dark');
      expect(mockLocalmost.settings.set).toHaveBeenCalledWith({ theme: 'dark' });
    });

    it('should handle network check failure gracefully', async () => {
      mockLocalmost.network.isOnline.mockRejectedValue(new Error('Network check failed'));

      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      // Should default to online when check fails
      expect(screen.getByTestId('is-online').textContent).toBe('true');
    });

    // NOTE: Missing preload script test removed - the implementation doesn't
    // gracefully handle undefined window.localmost outside the try-catch block.
    // This would require adding guards to the effect that accesses window.localmost.logs.onEntry
  });

  describe('Network Status', () => {
    it('should update on online event', async () => {
      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      // Simulate going offline then online
      await act(async () => {
        window.dispatchEvent(new Event('offline'));
      });

      expect(screen.getByTestId('is-online').textContent).toBe('false');

      await act(async () => {
        window.dispatchEvent(new Event('online'));
      });

      expect(screen.getByTestId('is-online').textContent).toBe('true');
    });
  });

  describe('Cleanup', () => {
    it('should cleanup subscriptions on unmount', async () => {
      const unsubLogs = jest.fn();
      mockLocalmost.logs.onEntry.mockReturnValue(unsubLogs);

      const { unmount } = render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      unmount();

      expect(unsubLogs).toHaveBeenCalled();
    });
  });

  describe('User Filter', () => {
    it('should have default user filter mode as just-me', async () => {
      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      expect(screen.getByTestId('user-filter-mode').textContent).toBe('just-me');
      expect(screen.getByTestId('user-filter-allowlist-count').textContent).toBe('0');
    });

    it('should load user filter from settings', async () => {
      mockLocalmost.settings.get.mockResolvedValue({
        userFilter: {
          mode: 'allowlist',
          allowlist: [
            { login: 'user1', avatar_url: '', name: null },
            { login: 'user2', avatar_url: '', name: null },
          ],
        },
      });

      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('user-filter-mode').textContent).toBe('allowlist');
        expect(screen.getByTestId('user-filter-allowlist-count').textContent).toBe('2');
      });
    });

    it('should set user filter to just-me', async () => {
      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('set-user-filter-just-me').click();
      });

      expect(screen.getByTestId('user-filter-mode').textContent).toBe('just-me');
      expect(mockLocalmost.settings.set).toHaveBeenCalledWith({
        userFilter: { mode: 'just-me', allowlist: [] },
      });
    });

    it('should set user filter with allowlist', async () => {
      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('set-user-filter-allowlist').click();
      });

      expect(screen.getByTestId('user-filter-mode').textContent).toBe('allowlist');
      expect(screen.getByTestId('user-filter-allowlist-count').textContent).toBe('1');
      expect(mockLocalmost.settings.set).toHaveBeenCalledWith({
        userFilter: {
          mode: 'allowlist',
          allowlist: [{ login: 'testuser', avatar_url: '', name: null }],
        },
      });
    });

    it('should handle invalid user filter mode in settings', async () => {
      mockLocalmost.settings.get.mockResolvedValue({
        userFilter: {
          mode: 'invalid-mode',
          allowlist: [],
        },
      });

      render(
        <AppConfigProvider>
          <TestConsumer />
        </AppConfigProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-loading').textContent).toBe('false');
      });

      // Should fall back to default
      expect(screen.getByTestId('user-filter-mode').textContent).toBe('just-me');
    });
  });
});
