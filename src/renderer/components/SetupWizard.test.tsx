import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import SetupWizard from './SetupWizard';
import { mockLocalmost } from '../../../test/setup-renderer';

describe('SetupWizard', () => {
  const defaultProps = {
    onComplete: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset all mocks to default state
    mockLocalmost.github.getAuthStatus.mockResolvedValue({ isAuthenticated: false });
    mockLocalmost.github.startDeviceFlow.mockResolvedValue({ success: true, user: { login: 'testuser', name: 'Test User', avatar_url: '' } });
    mockLocalmost.github.cancelAuth.mockResolvedValue(undefined);
    mockLocalmost.github.getRepos.mockResolvedValue({ success: true, repos: [] });
    mockLocalmost.github.onDeviceCode.mockReturnValue(() => {});
    mockLocalmost.runner.isDownloaded.mockResolvedValue(false);
    mockLocalmost.runner.isConfigured.mockResolvedValue(false);
    mockLocalmost.runner.download.mockResolvedValue({ success: true });
    mockLocalmost.runner.configure.mockResolvedValue({ success: true });
    mockLocalmost.runner.onDownloadProgress.mockReturnValue(() => {});
  });

  describe('Initial Render', () => {
    it('should render welcome header', async () => {
      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Welcome to localmost')).toBeInTheDocument();
      });
    });

    it('should render step indicators', async () => {
      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('1. Sign In')).toBeInTheDocument();
        expect(screen.getByText('2. Download')).toBeInTheDocument();
        expect(screen.getByText('3. Configure')).toBeInTheDocument();
      });
    });

    it('should start on auth step when not authenticated', async () => {
      render(<SetupWizard {...defaultProps} />);

      // Use findByRole which is better for async scenarios
      expect(await screen.findByRole('button', { name: /sign in with github/i })).toBeInTheDocument();
    });

    it('should show GitHub icon on auth step', async () => {
      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/Click below to authenticate/)).toBeInTheDocument();
      });
    });
  });

  describe('Auth Step - Already Authenticated', () => {
    it('should skip to download step if authenticated but not downloaded', async () => {
      mockLocalmost.github.getAuthStatus.mockResolvedValue({
        isAuthenticated: true,
        user: { login: 'testuser', name: 'Test', avatar_url: '' },
      });
      mockLocalmost.runner.isDownloaded.mockResolvedValue(false);

      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Download GitHub Actions Runner')).toBeInTheDocument();
      });
    });

    it('should skip to configure step if authenticated and downloaded', async () => {
      mockLocalmost.github.getAuthStatus.mockResolvedValue({
        isAuthenticated: true,
        user: { login: 'testuser', name: 'Test', avatar_url: '' },
      });
      mockLocalmost.runner.isDownloaded.mockResolvedValue(true);

      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Configure Runner')).toBeInTheDocument();
      });
    });
  });

  describe('Auth Step - Device Flow', () => {
    it('should show sign in button initially', async () => {
      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
      });
    });

    it('should start device flow on button click', async () => {
      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));

      await waitFor(() => {
        expect(mockLocalmost.github.startDeviceFlow).toHaveBeenCalled();
      });
    });

    it('should show device code when received', async () => {
      let deviceCodeCallback: (info: { userCode: string; verificationUri: string }) => void;
      mockLocalmost.github.onDeviceCode.mockImplementation((cb) => {
        deviceCodeCallback = cb;
        return () => {};
      });
      mockLocalmost.github.startDeviceFlow.mockImplementation(() => {
        // Don't resolve immediately - simulate waiting
        return new Promise(() => {});
      });

      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));

      // Simulate receiving device code
      act(() => {
        deviceCodeCallback!({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
      });

      await waitFor(() => {
        expect(screen.getByText('ABCD-1234')).toBeInTheDocument();
        expect(screen.getByText(/Waiting for authorization/)).toBeInTheDocument();
      });
    });

    it('should show cancel button during auth', async () => {
      mockLocalmost.github.startDeviceFlow.mockImplementation(() => new Promise(() => {}));

      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      });
    });

    it('should handle cancel auth', async () => {
      mockLocalmost.github.startDeviceFlow.mockImplementation(() => new Promise(() => {}));

      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => {
        expect(mockLocalmost.github.cancelAuth).toHaveBeenCalled();
      });
    });

    it('should show error on auth failure', async () => {
      mockLocalmost.github.startDeviceFlow.mockResolvedValue({
        success: false,
        error: 'Network error',
      });

      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
    });

    it('should proceed to download step on successful auth', async () => {
      mockLocalmost.github.startDeviceFlow.mockResolvedValue({
        success: true,
        user: { login: 'testuser', name: 'Test', avatar_url: '' },
      });
      mockLocalmost.runner.isDownloaded.mockResolvedValue(false);

      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));

      await waitFor(() => {
        expect(screen.getByText('Download GitHub Actions Runner')).toBeInTheDocument();
      });
    });
  });

  describe('Download Step', () => {
    beforeEach(() => {
      mockLocalmost.github.getAuthStatus.mockResolvedValue({
        isAuthenticated: true,
        user: { login: 'testuser', name: 'Test', avatar_url: '' },
      });
      mockLocalmost.runner.isDownloaded.mockResolvedValue(false);
    });

    it('should show download button', async () => {
      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Download Runner' })).toBeInTheDocument();
      });
    });

    it('should show download size hint', async () => {
      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/180MB/)).toBeInTheDocument();
      });
    });

    it('should start download on button click', async () => {
      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Download Runner' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Download Runner' }));

      await waitFor(() => {
        expect(mockLocalmost.runner.download).toHaveBeenCalled();
      });
    });

    it('should show progress during download', async () => {
      let progressCallback: (progress: { phase: string; percent: number; message: string }) => void;
      mockLocalmost.runner.onDownloadProgress.mockImplementation((cb) => {
        progressCallback = cb;
        return () => {};
      });
      mockLocalmost.runner.download.mockImplementation(() => new Promise(() => {}));

      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Download Runner' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Download Runner' }));

      // Simulate progress
      act(() => {
        progressCallback!({ phase: 'downloading', percent: 50, message: 'Downloading...' });
      });

      await waitFor(() => {
        expect(screen.getByText('Downloading...')).toBeInTheDocument();
      });
    });

    it('should proceed to configure on download complete', async () => {
      let progressCallback: (progress: { phase: string; percent: number; message: string }) => void;
      mockLocalmost.runner.onDownloadProgress.mockImplementation((cb) => {
        progressCallback = cb;
        return () => {};
      });
      mockLocalmost.runner.download.mockResolvedValue({ success: true });
      mockLocalmost.github.getRepos.mockResolvedValue({
        success: true,
        repos: [{ id: 1, full_name: 'user/repo', html_url: 'https://github.com/user/repo' }],
      });

      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Download Runner' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Download Runner' }));

      // Simulate completion
      act(() => {
        progressCallback!({ phase: 'complete', percent: 100, message: 'Done' });
      });

      await waitFor(() => {
        expect(screen.getByText('Configure Runner')).toBeInTheDocument();
      });
    });

    it('should show error on download failure', async () => {
      let progressCallback: (progress: { phase: string; percent: number; message: string }) => void;
      mockLocalmost.runner.onDownloadProgress.mockImplementation((cb) => {
        progressCallback = cb;
        return () => {};
      });
      mockLocalmost.runner.download.mockResolvedValue({ success: true });

      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Download Runner' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Download Runner' }));

      // Simulate error
      act(() => {
        progressCallback!({ phase: 'error', percent: 0, message: 'Download failed' });
      });

      await waitFor(() => {
        // May appear in both progress message and error message
        expect(screen.getAllByText('Download failed').length).toBeGreaterThan(0);
      });
    });
  });

  describe('Configure Step', () => {
    beforeEach(() => {
      mockLocalmost.github.getAuthStatus.mockResolvedValue({
        isAuthenticated: true,
        user: { login: 'testuser', name: 'Test', avatar_url: '' },
      });
      mockLocalmost.runner.isDownloaded.mockResolvedValue(true);
      mockLocalmost.github.getRepos.mockResolvedValue({
        success: true,
        repos: [
          { id: 1, full_name: 'user/repo1', html_url: 'https://github.com/user/repo1' },
          { id: 2, full_name: 'user/repo2', html_url: 'https://github.com/user/repo2' },
        ],
      });
    });

    it('should show configure form', async () => {
      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Configure Runner')).toBeInTheDocument();
        expect(screen.getByText('Repository')).toBeInTheDocument();
        expect(screen.getByText('Runner Name')).toBeInTheDocument();
        expect(screen.getByText('Labels (comma-separated)')).toBeInTheDocument();
      });
    });

    it('should show repository dropdown with options', async () => {
      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('user/repo1')).toBeInTheDocument();
        expect(screen.getByText('user/repo2')).toBeInTheDocument();
      });
    });

    it('should show finish button', async () => {
      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Finish Setup' })).toBeInTheDocument();
      });
    });

    it('should show error if no repo selected', async () => {
      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Finish Setup' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Finish Setup' }));

      await waitFor(() => {
        expect(screen.getByText('Please select a repository')).toBeInTheDocument();
      });
    });

    it('should call configure with selected options', async () => {
      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument();
      });

      // Select a repo
      fireEvent.change(screen.getByRole('combobox'), {
        target: { value: 'https://github.com/user/repo1' },
      });

      fireEvent.click(screen.getByRole('button', { name: 'Finish Setup' }));

      await waitFor(() => {
        expect(mockLocalmost.runner.configure).toHaveBeenCalledWith(
          expect.objectContaining({
            level: 'repo',
            repoUrl: 'https://github.com/user/repo1',
          })
        );
      });
    });

    it('should call onComplete after successful configuration', async () => {
      mockLocalmost.runner.configure.mockResolvedValue({ success: true });

      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByRole('combobox'), {
        target: { value: 'https://github.com/user/repo1' },
      });

      fireEvent.click(screen.getByRole('button', { name: 'Finish Setup' }));

      await waitFor(() => {
        expect(defaultProps.onComplete).toHaveBeenCalled();
      });
    });

    it('should show error on configuration failure', async () => {
      mockLocalmost.runner.configure.mockResolvedValue({
        success: false,
        error: 'Token expired',
      });

      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByRole('combobox'), {
        target: { value: 'https://github.com/user/repo1' },
      });

      fireEvent.click(screen.getByRole('button', { name: 'Finish Setup' }));

      await waitFor(() => {
        expect(screen.getByText('Token expired')).toBeInTheDocument();
      });
    });

    it('should allow changing labels', async () => {
      render(<SetupWizard {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('self-hosted,macOS,ARM64')).toBeInTheDocument();
      });

      const labelsInput = screen.getByPlaceholderText('self-hosted,macOS,ARM64');
      fireEvent.change(labelsInput, { target: { value: 'self-hosted,linux' } });

      // Select a repo
      fireEvent.change(screen.getByRole('combobox'), {
        target: { value: 'https://github.com/user/repo1' },
      });

      fireEvent.click(screen.getByRole('button', { name: 'Finish Setup' }));

      await waitFor(() => {
        expect(mockLocalmost.runner.configure).toHaveBeenCalledWith(
          expect.objectContaining({
            labels: ['self-hosted', 'linux'],
          })
        );
      });
    });
  });
});
