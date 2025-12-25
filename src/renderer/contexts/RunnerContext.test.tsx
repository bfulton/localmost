import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { RunnerProvider, useRunner } from './RunnerContext';
import { mockLocalmost } from '../../../test/setup-renderer';

// Test component that uses the context
const TestConsumer: React.FC = () => {
  const runner = useRunner();

  return (
    <div>
      <span data-testid="user">{runner.user?.login || 'no-user'}</span>
      <span data-testid="is-authenticating">{String(runner.isAuthenticating)}</span>
      <span data-testid="is-downloaded">{String(runner.isDownloaded)}</span>
      <span data-testid="is-configured">{String(runner.isConfigured)}</span>
      <span data-testid="runner-status">{runner.runnerState.status}</span>
      <span data-testid="error">{runner.error || 'no-error'}</span>
      <span data-testid="is-loading">{String(runner.isLoading)}</span>
      <span data-testid="is-initial-loading">{String(runner.isInitialLoading)}</span>
      <span data-testid="repos-count">{runner.repos.length}</span>
      <span data-testid="orgs-count">{runner.orgs.length}</span>
      <span data-testid="selected-version">{runner.selectedVersion}</span>
      <span data-testid="runner-display-name">{runner.runnerDisplayName || 'none'}</span>
      <button data-testid="login" onClick={runner.login}>Login</button>
      <button data-testid="logout" onClick={runner.logout}>Logout</button>
      <button data-testid="download" onClick={runner.downloadRunner}>Download</button>
      <button data-testid="configure" onClick={runner.configureRunner}>Configure</button>
      <button data-testid="set-error" onClick={() => runner.setError('test error')}>Set Error</button>
      <button data-testid="clear-error" onClick={() => runner.setError(null)}>Clear Error</button>
    </div>
  );
};

describe('RunnerContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset all mocks
    mockLocalmost.github.getAuthStatus.mockResolvedValue({ isAuthenticated: false });
    mockLocalmost.github.startDeviceFlow.mockResolvedValue({ success: true, user: { login: 'testuser', name: 'Test', avatar_url: '' } });
    mockLocalmost.github.logout.mockResolvedValue(undefined);
    mockLocalmost.github.getRepos.mockResolvedValue({ success: true, repos: [] });
    mockLocalmost.github.getOrgs.mockResolvedValue({ success: true, orgs: [] });
    mockLocalmost.github.onDeviceCode.mockReturnValue(() => {});
    mockLocalmost.runner.isDownloaded.mockResolvedValue(false);
    mockLocalmost.runner.isConfigured.mockResolvedValue(false);
    mockLocalmost.runner.getStatus.mockResolvedValue({ status: 'offline' });
    mockLocalmost.runner.getVersion.mockResolvedValue({ version: null, url: null });
    mockLocalmost.runner.getAvailableVersions.mockResolvedValue({ success: true, versions: [] });
    mockLocalmost.runner.getDisplayName.mockResolvedValue('');
    mockLocalmost.runner.onStatusUpdate.mockReturnValue(() => {});
    mockLocalmost.runner.onDownloadProgress.mockReturnValue(() => {});
    mockLocalmost.runner.download.mockResolvedValue({ success: true });
    mockLocalmost.runner.configure.mockResolvedValue({ success: true });
    mockLocalmost.runner.start.mockResolvedValue({ success: true });
    mockLocalmost.runner.setDownloadVersion.mockResolvedValue(undefined);
    mockLocalmost.settings.get.mockResolvedValue({});
    mockLocalmost.jobs.getHistory.mockResolvedValue([]);
    mockLocalmost.jobs.onHistoryUpdate.mockReturnValue(() => {});
    mockLocalmost.app.getHostname.mockResolvedValue('test-host');
  });

  describe('useRunner hook', () => {
    it('should throw when used outside provider', () => {
      // Suppress console.error for this test
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        render(<TestConsumer />);
      }).toThrow('useRunner must be used within a RunnerProvider');

      spy.mockRestore();
    });
  });

  describe('Initial State', () => {
    it('should show initial loading state', async () => {
      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      // Initially loading
      expect(screen.getByTestId('is-initial-loading').textContent).toBe('true');

      // Wait for loading to complete
      await waitFor(() => {
        expect(screen.getByTestId('is-initial-loading').textContent).toBe('false');
      });
    });

    it('should load auth status on mount', async () => {
      mockLocalmost.github.getAuthStatus.mockResolvedValue({
        isAuthenticated: true,
        user: { login: 'testuser', name: 'Test User', avatar_url: '' },
      });

      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('user').textContent).toBe('testuser');
      });
    });

    it('should load runner status on mount', async () => {
      mockLocalmost.runner.isDownloaded.mockResolvedValue(true);
      mockLocalmost.runner.isConfigured.mockResolvedValue(true);
      mockLocalmost.runner.getStatus.mockResolvedValue({ status: 'running' });

      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-downloaded').textContent).toBe('true');
        expect(screen.getByTestId('is-configured').textContent).toBe('true');
        expect(screen.getByTestId('runner-status').textContent).toBe('running');
      });
    });

    it('should load repos and orgs when authenticated', async () => {
      mockLocalmost.github.getAuthStatus.mockResolvedValue({
        isAuthenticated: true,
        user: { login: 'testuser', name: 'Test', avatar_url: '' },
      });
      mockLocalmost.github.getRepos.mockResolvedValue({
        success: true,
        repos: [{ id: 1, full_name: 'user/repo', html_url: '' }],
      });
      mockLocalmost.github.getOrgs.mockResolvedValue({
        success: true,
        orgs: [{ id: 1, login: 'myorg', avatar_url: '' }],
      });

      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('repos-count').textContent).toBe('1');
        expect(screen.getByTestId('orgs-count').textContent).toBe('1');
      });
    });

    it('should load runner config from settings', async () => {
      mockLocalmost.settings.get.mockResolvedValue({
        runnerConfig: {
          level: 'repo',
          repoUrl: 'https://github.com/user/repo',
          runnerName: 'my-runner',
          labels: 'self-hosted,macOS',
          runnerCount: 4,
        },
      });

      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-initial-loading').textContent).toBe('false');
      });
    });

    it('should set default runner name based on hostname', async () => {
      mockLocalmost.app.getHostname.mockResolvedValue('my-machine');
      mockLocalmost.settings.get.mockResolvedValue({});

      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(mockLocalmost.app.getHostname).toHaveBeenCalled();
      });
    });
  });

  describe('Authentication', () => {
    it('should handle login', async () => {
      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-initial-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('login').click();
      });

      await waitFor(() => {
        expect(mockLocalmost.github.startDeviceFlow).toHaveBeenCalled();
        expect(screen.getByTestId('user').textContent).toBe('testuser');
      });
    });

    it('should set error on login failure', async () => {
      mockLocalmost.github.startDeviceFlow.mockResolvedValue({
        success: false,
        error: 'Auth failed',
      });

      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-initial-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('login').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('error').textContent).toBe('Auth failed');
      });
    });

    it('should handle logout', async () => {
      mockLocalmost.github.getAuthStatus.mockResolvedValue({
        isAuthenticated: true,
        user: { login: 'testuser', name: 'Test', avatar_url: '' },
      });

      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('user').textContent).toBe('testuser');
      });

      await act(async () => {
        screen.getByTestId('logout').click();
      });

      await waitFor(() => {
        expect(mockLocalmost.github.logout).toHaveBeenCalled();
        expect(screen.getByTestId('user').textContent).toBe('no-user');
      });
    });
  });

  describe('Runner Download', () => {
    it('should handle download', async () => {
      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-initial-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('download').click();
      });

      await waitFor(() => {
        expect(mockLocalmost.runner.download).toHaveBeenCalled();
      });
    });

    it('should set error on download failure', async () => {
      mockLocalmost.runner.download.mockResolvedValue({
        success: false,
        error: 'Download failed',
      });

      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-initial-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('download').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('error').textContent).toBe('Download failed');
      });
    });

    it('should update state on download progress complete', async () => {
      let progressCallback: (progress: any) => void;
      mockLocalmost.runner.onDownloadProgress.mockImplementation((cb) => {
        progressCallback = cb;
        return () => {};
      });
      mockLocalmost.runner.getVersion.mockResolvedValue({ version: '2.330.0', url: '' });

      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-initial-loading').textContent).toBe('false');
      });

      // Simulate download completion
      await act(async () => {
        progressCallback!({ phase: 'complete', percent: 100, message: 'Done' });
      });

      await waitFor(() => {
        expect(screen.getByTestId('is-downloaded').textContent).toBe('true');
      });
    });
  });

  describe('Runner Configuration', () => {
    it('should return error if no repo selected', async () => {
      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-initial-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('configure').click();
      });

      await waitFor(() => {
        // configureRunner returns { success: false, error: 'Please select a repository' }
        expect(mockLocalmost.runner.configure).not.toHaveBeenCalled();
      });
    });

    it('should start runner after successful configuration', async () => {
      mockLocalmost.settings.get.mockResolvedValue({
        runnerConfig: {
          level: 'repo',
          repoUrl: 'https://github.com/user/repo',
          runnerName: 'my-runner',
          labels: 'self-hosted',
          runnerCount: 1,
        },
      });
      mockLocalmost.runner.configure.mockResolvedValue({ success: true });

      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-initial-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('configure').click();
      });

      await waitFor(() => {
        expect(mockLocalmost.runner.configure).toHaveBeenCalled();
        expect(mockLocalmost.runner.start).toHaveBeenCalled();
      });
    });
  });

  describe('Error Handling', () => {
    it('should allow setting and clearing errors', async () => {
      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-initial-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('set-error').click();
      });

      expect(screen.getByTestId('error').textContent).toBe('test error');

      await act(async () => {
        screen.getByTestId('clear-error').click();
      });

      expect(screen.getByTestId('error').textContent).toBe('no-error');
    });

    it('should handle initial load failure', async () => {
      mockLocalmost.github.getAuthStatus.mockRejectedValue(new Error('Network error'));

      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('error').textContent).toContain('Failed to load runner state');
      });
    });

    it('should handle login failure', async () => {
      // The context checks result.success, not exceptions
      mockLocalmost.github.startDeviceFlow.mockResolvedValue({
        success: false,
        error: 'OAuth authorization denied',
      });

      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-initial-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('login').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('error').textContent).toContain('OAuth authorization denied');
      });

      // Should not be authenticating after failure
      expect(screen.getByTestId('is-authenticating').textContent).toBe('false');
    });

    it('should handle runner download failure', async () => {
      // The context checks result.success, not exceptions
      mockLocalmost.runner.download.mockResolvedValue({
        success: false,
        error: 'Network timeout during download',
      });

      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-initial-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('download').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('error').textContent).toContain('Network timeout during download');
      });

      expect(screen.getByTestId('is-loading').textContent).toBe('false');
    });

    it('should handle runner configure failure', async () => {
      // Need to set up runnerConfig so validation passes
      mockLocalmost.settings.get.mockResolvedValue({
        runnerConfig: {
          level: 'repo',
          repoUrl: 'https://github.com/user/repo',
          runnerName: 'my-runner',
          labels: 'self-hosted',
          runnerCount: 1,
        },
      });
      mockLocalmost.runner.isDownloaded.mockResolvedValue(true);
      // The context checks result.success, not exceptions
      mockLocalmost.runner.configure.mockResolvedValue({
        success: false,
        error: 'Invalid registration token',
      });

      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-initial-loading').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByTestId('configure').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('error').textContent).toContain('Invalid registration token');
      });
    });
  });

  describe('Subscriptions', () => {
    it('should subscribe to status updates', async () => {
      let statusCallback: (status: any) => void;
      mockLocalmost.runner.onStatusUpdate.mockImplementation((cb) => {
        statusCallback = cb;
        return () => {};
      });

      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-initial-loading').textContent).toBe('false');
      });

      // Simulate status update
      await act(async () => {
        statusCallback!({ status: 'busy', jobName: 'Test Job' });
      });

      expect(screen.getByTestId('runner-status').textContent).toBe('busy');
    });

    it('should subscribe to job history updates', async () => {
      mockLocalmost.jobs.onHistoryUpdate.mockImplementation(() => {
        // Callback captured for subscription, not invoked in this test
        return () => {};
      });

      render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-initial-loading').textContent).toBe('false');
      });

      expect(mockLocalmost.jobs.onHistoryUpdate).toHaveBeenCalled();
    });

    it('should cleanup subscriptions on unmount', async () => {
      const unsubStatus = jest.fn();
      const unsubHistory = jest.fn();
      const unsubDeviceCode = jest.fn();
      const unsubDownload = jest.fn();

      mockLocalmost.runner.onStatusUpdate.mockReturnValue(unsubStatus);
      mockLocalmost.jobs.onHistoryUpdate.mockReturnValue(unsubHistory);
      mockLocalmost.github.onDeviceCode.mockReturnValue(unsubDeviceCode);
      mockLocalmost.runner.onDownloadProgress.mockReturnValue(unsubDownload);

      const { unmount } = render(
        <RunnerProvider>
          <TestConsumer />
        </RunnerProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('is-initial-loading').textContent).toBe('false');
      });

      unmount();

      expect(unsubStatus).toHaveBeenCalled();
      expect(unsubHistory).toHaveBeenCalled();
      expect(unsubDeviceCode).toHaveBeenCalled();
      expect(unsubDownload).toHaveBeenCalled();
    });
  });
});
