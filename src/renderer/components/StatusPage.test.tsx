import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import StatusPage from './StatusPage';
import { AppConfigProvider } from '../contexts/AppConfigContext';
import { RunnerProvider } from '../contexts/RunnerContext';
import { mockLocalmost } from '../../../test/setup-renderer';

// Wrapper component that provides both contexts
const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AppConfigProvider>
    <RunnerProvider>
      {children}
    </RunnerProvider>
  </AppConfigProvider>
);

const renderWithProviders = (ui: React.ReactElement) => {
  return render(ui, { wrapper: TestWrapper });
};

describe('StatusPage', () => {
  const defaultProps = {
    onOpenSettings: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mock implementations
    mockLocalmost.github.getAuthStatus.mockResolvedValue({ isAuthenticated: false });
    mockLocalmost.runner.isDownloaded.mockResolvedValue(false);
    mockLocalmost.runner.isConfigured.mockResolvedValue(false);
    mockLocalmost.runner.getStatus.mockResolvedValue({ status: 'offline' });
    mockLocalmost.runner.getVersion.mockResolvedValue({ version: null, url: null });
    mockLocalmost.runner.getAvailableVersions.mockResolvedValue({
      success: true,
      versions: [{ version: '2.330.0', url: '', publishedAt: '' }],
    });
    mockLocalmost.settings.get.mockResolvedValue({});
    mockLocalmost.jobs.getHistory.mockResolvedValue([]);
    mockLocalmost.logs.getPath.mockResolvedValue('/tmp/logs');
    mockLocalmost.app.getHostname.mockResolvedValue('test-host');
    mockLocalmost.network.isOnline.mockResolvedValue(true);
  });

  it('should render status page header', async () => {
    renderWithProviders(<StatusPage {...defaultProps} />);

    // Wait for initial async state to settle
    await waitFor(() => {
      expect(screen.getByText('Status')).toBeInTheDocument();
    });
  });

  it('should render GitHub status item', async () => {
    renderWithProviders(<StatusPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('GitHub')).toBeInTheDocument();
    });
  });

  it('should render Runner status item', async () => {
    renderWithProviders(<StatusPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Runner')).toBeInTheDocument();
    });
  });

  it('should render Job status item', async () => {
    renderWithProviders(<StatusPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Job')).toBeInTheDocument();
    });
  });

  it('should show settings button', async () => {
    renderWithProviders(<StatusPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTitle('Settings')).toBeInTheDocument();
    });
  });

  it('should call onOpenSettings when settings button clicked', async () => {
    renderWithProviders(<StatusPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTitle('Settings')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Settings'));
    expect(defaultProps.onOpenSettings).toHaveBeenCalled();
  });

  it('should show connected status when authenticated', async () => {
    mockLocalmost.github.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
    });

    renderWithProviders(<StatusPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Connected')).toBeInTheDocument();
    });
  });

  it('should show runner listening when running', async () => {
    mockLocalmost.github.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
    });
    mockLocalmost.runner.isDownloaded.mockResolvedValue(true);
    mockLocalmost.runner.isConfigured.mockResolvedValue(true);
    mockLocalmost.runner.getStatus.mockResolvedValue({ status: 'running' });

    renderWithProviders(<StatusPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Listening')).toBeInTheDocument();
    });
  });

  it('should render logs section', async () => {
    renderWithProviders(<StatusPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Logs')).toBeInTheDocument();
    });
  });

  it('should expand logs when clicked', async () => {
    renderWithProviders(<StatusPage {...defaultProps} />);

    // Wait for component to settle
    await waitFor(() => {
      expect(screen.getByText('Logs')).toBeInTheDocument();
    });

    const logsHeader = screen.getByText('Logs').closest('.logs-header');
    if (logsHeader) {
      fireEvent.click(logsHeader);
    }

    await waitFor(() => {
      expect(screen.getByText('No logs yet')).toBeInTheDocument();
    });
  });

  it('should show sleep info when configured', async () => {
    mockLocalmost.github.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
    });
    mockLocalmost.runner.isDownloaded.mockResolvedValue(true);
    mockLocalmost.runner.isConfigured.mockResolvedValue(true);
    mockLocalmost.runner.getStatus.mockResolvedValue({ status: 'running' });

    renderWithProviders(<StatusPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Sleep allowed')).toBeInTheDocument();
    });
  });

  it('should show sleep blocked when busy with protection enabled', async () => {
    mockLocalmost.github.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
    });
    mockLocalmost.runner.isDownloaded.mockResolvedValue(true);
    mockLocalmost.runner.isConfigured.mockResolvedValue(true);
    mockLocalmost.runner.getStatus.mockResolvedValue({
      status: 'busy',
      jobName: 'Test Job',
    });
    mockLocalmost.settings.get.mockResolvedValue({
      sleepProtection: 'when-busy',
      sleepProtectionConsented: true,
    });

    renderWithProviders(<StatusPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/Sleep/)).toBeInTheDocument();
      expect(screen.getByText(/blocked/)).toBeInTheDocument();
    });
  });
});
