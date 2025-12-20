import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettingsPage from './SettingsPage';
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

describe('SettingsPage', () => {
  const defaultProps = {
    onBack: jest.fn(),
    scrollToSection: undefined,
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mock implementations
    mockLocalmost.github.getAuthStatus.mockResolvedValue({ isAuthenticated: false });
    mockLocalmost.runner.isDownloaded.mockResolvedValue(false);
    mockLocalmost.runner.isConfigured.mockResolvedValue(false);
    mockLocalmost.runner.getVersion.mockResolvedValue({ version: null, url: null });
    mockLocalmost.runner.getAvailableVersions.mockResolvedValue({
      success: true,
      versions: [{ version: '2.330.0', url: '', publishedAt: '' }],
    });
    mockLocalmost.settings.get.mockResolvedValue({});
    mockLocalmost.runner.getStatus.mockResolvedValue({ status: 'offline' });
    mockLocalmost.jobs.getHistory.mockResolvedValue([]);
    mockLocalmost.app.getHostname.mockResolvedValue('test-host');
    mockLocalmost.network.isOnline.mockResolvedValue(true);
  });

  it('should render settings page header', async () => {
    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });
  });

  it('should render close button', async () => {
    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTitle('Close settings')).toBeInTheDocument();
    });
  });

  it('should call onBack when close button clicked', async () => {
    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTitle('Close settings')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Close settings'));
    expect(defaultProps.onBack).toHaveBeenCalled();
  });

  it('should render GitHub Account section', async () => {
    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('GitHub Account')).toBeInTheDocument();
    });
  });

  it('should show sign in button when not authenticated', async () => {
    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Sign in with GitHub')).toBeInTheDocument();
    });
  });

  it('should show sign out button when authenticated', async () => {
    mockLocalmost.github.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
    });

    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Sign Out')).toBeInTheDocument();
    });
  });

  it('should render Runner Binary section', async () => {
    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Runner Binary')).toBeInTheDocument();
    });
  });

  it('should render History section', async () => {
    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('History')).toBeInTheDocument();
    });
  });

  it('should render Power section', async () => {
    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Power')).toBeInTheDocument();
    });
  });

  it('should render Appearance section', async () => {
    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Appearance')).toBeInTheDocument();
    });
  });

  it('should render theme options', async () => {
    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Light')).toBeInTheDocument();
      expect(screen.getByText('Dark')).toBeInTheDocument();
      expect(screen.getByText('Auto')).toBeInTheDocument();
    });
  });

  it('should call settings.set when theme option clicked', async () => {
    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Dark')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Dark'));

    await waitFor(() => {
      expect(mockLocalmost.settings.set).toHaveBeenCalledWith({ theme: 'dark' });
    });
  });

  it('should render max log scrollback selector', async () => {
    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Max log scrollback')).toBeInTheDocument();
    });
  });

  it('should render prevent sleep selector', async () => {
    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Prevent sleep')).toBeInTheDocument();
    });
  });

  it('should show download button when runner not downloaded', async () => {
    mockLocalmost.runner.isDownloaded.mockResolvedValue(false);

    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Download Runner')).toBeInTheDocument();
    });
  });

  it('should show version selector', async () => {
    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Version')).toBeInTheDocument();
    });
  });

  it('should show runner configuration when downloaded and authenticated', async () => {
    mockLocalmost.github.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
    });
    mockLocalmost.runner.isDownloaded.mockResolvedValue(true);

    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Runner Configuration')).toBeInTheDocument();
    });
  });

  it('should show runner level options when configuring', async () => {
    mockLocalmost.github.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
    });
    mockLocalmost.runner.isDownloaded.mockResolvedValue(true);

    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      // Use getAllByText since Repository/Organization appear as both level options and labels
      expect(screen.getAllByText('Repository').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Organization').length).toBeGreaterThan(0);
    });
  });
});
