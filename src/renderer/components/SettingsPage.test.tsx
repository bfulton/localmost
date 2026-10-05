import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettingsPage from './SettingsPage';
import { AppConfigProvider } from '../contexts/AppConfigContext';
import { RunnerProvider } from '../contexts/RunnerContext';
import { UpdateProvider } from '../contexts/UpdateContext';
import { mockLocalmost } from '../../../test/setup-renderer';
import { seedZubridge, resetZubridge } from '../../../test/zubridge-state';

// Wrapper component that provides all required contexts
const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AppConfigProvider>
    <RunnerProvider>
      <UpdateProvider>
        {children}
      </UpdateProvider>
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

  it('offers Reconnect when the session is expired, not just Sign Out', async () => {
    // The state the app used to hide: a stored session it cannot use. It kept
    // showing the account with a Sign Out button while every job was refused
    // for "not authenticated". This test exists because the wiring that
    // carries `expired` into the context was silently a no-op once - typecheck
    // and every other test stayed green, because the field has a default.
    mockLocalmost.github.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      expired: true,
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
    });

    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Session expired')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    // Additive: the account renders exactly as it always has, badge alongside.
    // Two attempts at changing what the app considers its auth state - what
    // `user` is, what isAuthenticated returns - ended in a render loop.
    expect(screen.getByText('Sign Out')).toBeInTheDocument();
    expect(screen.getByText('@testuser')).toBeInTheDocument();
  });

  it('shows the device code where Reconnect started it, not only in the signed-out panel', async () => {
    // Reconnect runs from the signed-in branch, so the code must render there.
    // The existing panel lives in the signed-out branch, which an expired
    // session never reaches - so the browser opened asking for a code the app
    // was not showing anywhere.
    mockLocalmost.github.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      expired: true,
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
    });
    mockLocalmost.github.onDeviceCode.mockImplementation((cb: (c: unknown) => void) => {
      cb({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
      return () => undefined;
    });

    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('ABCD-1234')).toBeInTheDocument();
    });
  });

  it('shows no Reconnect button for a healthy session', async () => {
    mockLocalmost.github.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
    });

    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Sign Out')).toBeInTheDocument();
    });
    expect(screen.queryByText('Session expired')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
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

  it('should show runner configuration options when authenticated', async () => {
    mockLocalmost.github.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
    });
    mockLocalmost.runner.isDownloaded.mockResolvedValue(true);

    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Runner Name')).toBeInTheDocument();
      expect(screen.getByText('Labels (comma-separated)')).toBeInTheDocument();
      expect(screen.getByText('Parallelism')).toBeInTheDocument();
    });
  });

  it('offers no setting to keep a job\'s _work directory or tools for later jobs', async () => {
    mockLocalmost.github.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
    });
    mockLocalmost.runner.isDownloaded.mockResolvedValue(true);

    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Parallelism')).toBeInTheDocument();
    });
    // A macOS VM job's tools and work directory go with its VM.
    expect(screen.queryByText('Tool cache')).not.toBeInTheDocument();
    expect(screen.queryByText('Cache work directory')).not.toBeInTheDocument();
    expect(screen.queryByText(/_work directory/)).not.toBeInTheDocument();
  });

  it('says what debug runner logging writes to disk', async () => {
    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Runner log level')).toBeInTheDocument();
    });
    expect(screen.getByText(/runner's diagnostic trace/)).toHaveTextContent('~/.localmost/logs');
  });
});

describe('the resource-pause preference', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLocalmost.github.getAuthStatus.mockResolvedValue({ isAuthenticated: false });
    mockLocalmost.runner.isDownloaded.mockResolvedValue(false);
    mockLocalmost.runner.isConfigured.mockResolvedValue(false);
    mockLocalmost.runner.getVersion.mockResolvedValue({ version: null, url: null });
    mockLocalmost.runner.getAvailableVersions.mockResolvedValue({ success: true, versions: [] });
    mockLocalmost.settings.get.mockResolvedValue({});
    mockLocalmost.settings.set.mockResolvedValue({ success: true });
    mockLocalmost.runner.getStatus.mockResolvedValue({ status: 'offline' });
    mockLocalmost.jobs.getHistory.mockResolvedValue([]);
    mockLocalmost.network.isOnline.mockResolvedValue(true);
  });

  afterEach(() => resetZubridge());

  const runningJobsSelect = () => screen.getByLabelText('Running jobs when a pause begins') as HTMLSelectElement;

  it('lets running jobs finish by default, and offers to stop them', async () => {
    renderWithProviders(<SettingsPage onBack={jest.fn()} />);

    await waitFor(() => expect(runningJobsSelect().value).toBe('finish'));
    expect(Array.from(runningJobsSelect().options).map((o) => [o.value, o.text])).toEqual([
      ['finish', 'Let them finish'],
      ['stop', 'Stop them'],
    ]);
    // What stopping costs, said where it is chosen.
    expect(screen.getByText(/their jobs fail on GitHub/)).toBeInTheDocument();

    fireEvent.change(runningJobsSelect(), { target: { value: 'stop' } });
    await waitFor(() => {
      expect(mockLocalmost.settings.set).toHaveBeenCalledWith({ resourcePause: { runningJobs: 'stop' } });
    });
  });

  it('shows the saved choice', async () => {
    mockLocalmost.settings.get.mockResolvedValue({ resourcePause: { runningJobs: 'stop' } });
    renderWithProviders(<SettingsPage onBack={jest.fn()} />);

    await waitFor(() => expect(runningJobsSelect().value).toBe('stop'));
  });

  it('shows a saved value the runner would not use as the default it uses instead', async () => {
    mockLocalmost.settings.get.mockResolvedValue({ resourcePause: { runningJobs: 'kill' } });
    renderWithProviders(<SettingsPage onBack={jest.fn()} />);

    await waitFor(() => expect(mockLocalmost.settings.get).toHaveBeenCalled());
    expect(runningJobsSelect().value).toBe('finish');
  });

  it('reads it from the store, not the settings file, once the store is populated', async () => {
    // The store branch is the one the app runs; settings:get is only the
    // fallback until zubridge syncs.
    seedZubridge({ config: { resourcePause: { runningJobs: 'stop' } } });
    renderWithProviders(<SettingsPage onBack={jest.fn()} />);

    await waitFor(() => expect(runningJobsSelect().value).toBe('stop'));
  });
});

describe('the macOS VM section', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLocalmost.github.getAuthStatus.mockResolvedValue({ isAuthenticated: false });
    mockLocalmost.runner.isDownloaded.mockResolvedValue(false);
    mockLocalmost.runner.isConfigured.mockResolvedValue(false);
    mockLocalmost.runner.getVersion.mockResolvedValue({ version: null, url: null });
    mockLocalmost.runner.getAvailableVersions.mockResolvedValue({ success: true, versions: [] });
    mockLocalmost.settings.get.mockResolvedValue({});
    mockLocalmost.runner.getStatus.mockResolvedValue({ status: 'offline' });
    mockLocalmost.jobs.getHistory.mockResolvedValue([]);
    mockLocalmost.network.isOnline.mockResolvedValue(true);
    mockLocalmost.macosVm.getStatus.mockResolvedValue({
      state: 'not-built', disk: { freeBytes: 80 * 2 ** 30, neededBytes: 60 * 2 ** 30 }, provisioning: 'guided', busy: false,
    });
  });

  it("says every job runs in one, and shows the golden image's setup in place of the isolation choice", async () => {
    renderWithProviders(<SettingsPage onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Build the golden image' })).toBeInTheDocument());
    const section = screen.getByText('macOS VM').closest('section') as HTMLElement;
    expect(section).toHaveTextContent(/Every job runs in a fresh macOS VM/);
    expect(section).toHaveTextContent(/takes no jobs until the image is ready/);
    expect(screen.queryByText('Isolation')).not.toBeInTheDocument();
    expect(screen.queryByText('Job Environment')).not.toBeInTheDocument();
  });
});
