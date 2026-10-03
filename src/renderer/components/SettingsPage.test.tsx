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

  it('offers no setting to keep a job\'s _work directory for later jobs', async () => {
    mockLocalmost.github.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
    });
    mockLocalmost.runner.isDownloaded.mockResolvedValue(true);

    renderWithProviders(<SettingsPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Tool cache')).toBeInTheDocument();
    });
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

describe('the resource-pause and job-environment preferences', () => {
  const DEFAULTS = { toolShims: true, javaToolOptions: true, perJobTempDir: true, createMissingGrantedDirs: true, swiftBuildLinkTemp: false };
  // Each convenience's control, by the label the page gives it.
  const CONVENIENCES = [
    ['toolShims', "Turn off SwiftPM's and Xcode's own sandbox"],
    ['javaToolOptions', 'Set JAVA_TOOL_OPTIONS for JVMs'],
    ['perJobTempDir', 'Give each job its own temp directory for Foundation'],
    ['createMissingGrantedDirs', 'Create missing directories a policy grants'],
  ] as const;

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
  const checkbox = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

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

  it('shows a saved value the runner would not use as the default it uses instead, and sends that', async () => {
    // The runner takes a value that is not true or false as absent, so the
    // shims are on; showing 0 as off would show the wrong thing, and sending
    // it back with the next change would have the whole section refused.
    mockLocalmost.settings.get.mockResolvedValue({
      resourcePause: { runningJobs: 'kill' },
      jobEnvironment: { toolShims: 0, javaToolOptions: false },
    });
    renderWithProviders(<SettingsPage onBack={jest.fn()} />);

    await waitFor(() => expect(checkbox('Set JAVA_TOOL_OPTIONS for JVMs').checked).toBe(false));
    expect(runningJobsSelect().value).toBe('finish');
    expect(checkbox("Turn off SwiftPM's and Xcode's own sandbox").checked).toBe(true);

    fireEvent.click(checkbox('Create missing directories a policy grants'));
    await waitFor(() => {
      expect(mockLocalmost.settings.set).toHaveBeenCalledWith({
        jobEnvironment: { ...DEFAULTS, javaToolOptions: false, createMissingGrantedDirs: false },
      });
    });
  });

  it('has every job-environment convenience on by default', async () => {
    renderWithProviders(<SettingsPage onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Job Environment')).toBeInTheDocument());
    for (const [, label] of CONVENIENCES) {
      expect({ label, checked: checkbox(label).checked }).toEqual({ label, checked: true });
    }
  });

  it.each(CONVENIENCES)('turns %s off on its own, and back on', async (key, label) => {
    renderWithProviders(<SettingsPage onBack={jest.fn()} />);
    await waitFor(() => expect(checkbox(label).checked).toBe(true));

    fireEvent.click(checkbox(label));
    await waitFor(() => {
      expect(mockLocalmost.settings.set).toHaveBeenLastCalledWith({ jobEnvironment: { ...DEFAULTS, [key]: false } });
    });
    await waitFor(() => expect(checkbox(label).checked).toBe(false));

    fireEvent.click(checkbox(label));
    await waitFor(() => {
      expect(mockLocalmost.settings.set).toHaveBeenLastCalledWith({ jobEnvironment: DEFAULTS });
    });
  });

  it('says, beside the toggle, what a missing granted directory needs while creating them is off', async () => {
    // Off, nothing creates a granted directory under the home that is not
    // there, and the job finds out only at its first write: say so where the
    // choice is made, and that the user must create it first.
    const offHint = /under your home, or one above it, .*must create it yourself before the job runs.*"Operation not permitted" at its first write there/;
    const onHint = /nothing to create yourself before a job/;
    renderWithProviders(<SettingsPage onBack={jest.fn()} />);
    const label = 'Create missing directories a policy grants';
    await waitFor(() => expect(checkbox(label).checked).toBe(true));
    const group = checkbox(label).closest('div') as HTMLElement;
    expect(group).toHaveTextContent(onHint);
    expect(group).not.toHaveTextContent(offHint);
    expect(screen.queryByText(offHint)).not.toBeInTheDocument();

    fireEvent.click(checkbox(label));
    await waitFor(() => expect(checkbox(label).checked).toBe(false));
    expect(group).toHaveTextContent(offHint);
    expect(group).not.toHaveTextContent(onHint);

    // Only beside its own toggle: turning another off says nothing of it.
    fireEvent.click(checkbox(label));
    await waitFor(() => expect(checkbox(label).checked).toBe(true));
    fireEvent.click(checkbox('Set JAVA_TOOL_OPTIONS for JVMs'));
    await waitFor(() => expect(checkbox('Set JAVA_TOOL_OPTIONS for JVMs').checked).toBe(false));
    expect(screen.queryByText(offHint)).not.toBeInTheDocument();
    expect(group).toHaveTextContent(onHint);
  });

  describe("the Swift Build link-temp grant", () => {
    const label = 'Let Swift Build link in the shared temp directory';
    const onHint =
      /a job may create <T>\/TemporaryDirectory\.XXXXXX names in the shared per-user temp directory, which your own SwiftPM and Xcode also use for manifest executables, so a job could race to replace one before it runs/;
    const offHint =
      /Off \(the default\): Swift 6\.4's default build system fails to link inside a job\. A workflow can pass swift build --build-system native, or the repository can use the macOS VM isolation type once it is available/;

    it('is off by default, and says beside it what off costs', async () => {
      renderWithProviders(<SettingsPage onBack={jest.fn()} />);
      await waitFor(() => expect(checkbox(label).checked).toBe(false));
      const group = checkbox(label).closest('div') as HTMLElement;
      expect(group).toHaveTextContent(offHint);
      expect(group).not.toHaveTextContent(onHint);
    });

    it('turns on, sending every key, and says beside it what on exposes', async () => {
      renderWithProviders(<SettingsPage onBack={jest.fn()} />);
      await waitFor(() => expect(checkbox(label).checked).toBe(false));
      const group = checkbox(label).closest('div') as HTMLElement;

      fireEvent.click(checkbox(label));
      await waitFor(() => {
        expect(mockLocalmost.settings.set).toHaveBeenLastCalledWith({ jobEnvironment: { ...DEFAULTS, swiftBuildLinkTemp: true } });
      });
      await waitFor(() => expect(checkbox(label).checked).toBe(true));
      expect(group).toHaveTextContent(onHint);
      expect(group).not.toHaveTextContent(offHint);

      fireEvent.click(checkbox(label));
      await waitFor(() => {
        expect(mockLocalmost.settings.set).toHaveBeenLastCalledWith({ jobEnvironment: DEFAULTS });
      });
    });

    it('shows a saved choice to turn it on', async () => {
      mockLocalmost.settings.get.mockResolvedValue({ jobEnvironment: { swiftBuildLinkTemp: true } });
      renderWithProviders(<SettingsPage onBack={jest.fn()} />);

      await waitFor(() => expect(checkbox(label).checked).toBe(true));
      expect(screen.getByText(onHint)).toBeInTheDocument();
      for (const [, other] of CONVENIENCES) expect(checkbox(other).checked).toBe(true);
    });
  });

  it('shows the off hint for a saved choice to leave missing granted directories alone', async () => {
    mockLocalmost.settings.get.mockResolvedValue({ jobEnvironment: { createMissingGrantedDirs: false } });
    renderWithProviders(<SettingsPage onBack={jest.fn()} />);

    await waitFor(() => expect(checkbox('Create missing directories a policy grants').checked).toBe(false));
    expect(screen.getByText(/must create it yourself before the job runs/)).toBeInTheDocument();
  });

  it.each(CONVENIENCES)('shows %s as saved', async (key, label) => {
    mockLocalmost.settings.get.mockResolvedValue({ jobEnvironment: { [key]: false } });
    renderWithProviders(<SettingsPage onBack={jest.fn()} />);

    await waitFor(() => expect(checkbox(label).checked).toBe(false));
    for (const [otherKey, otherLabel] of CONVENIENCES) {
      if (otherKey !== key) expect({ otherLabel, checked: checkbox(otherLabel).checked }).toEqual({ otherLabel, checked: true });
    }
  });

  describe('with the store populated, as in the app', () => {
    it('reads both from the store, not the settings file', async () => {
      // The store branch is the one the app runs; settings:get is only the
      // fallback until zubridge syncs.
      seedZubridge({
        config: {
          resourcePause: { runningJobs: 'stop' },
          jobEnvironment: { ...DEFAULTS, perJobTempDir: false },
        },
      });
      renderWithProviders(<SettingsPage onBack={jest.fn()} />);

      await waitFor(() => expect(runningJobsSelect().value).toBe('stop'));
      expect(checkbox('Give each job its own temp directory for Foundation').checked).toBe(false);
      expect(checkbox('Set JAVA_TOOL_OPTIONS for JVMs').checked).toBe(true);
    });

    it('sends the change from the store value, keeping the others', async () => {
      seedZubridge({ config: { jobEnvironment: { ...DEFAULTS, toolShims: false } } });
      renderWithProviders(<SettingsPage onBack={jest.fn()} />);
      await waitFor(() => expect(checkbox('Create missing directories a policy grants').checked).toBe(true));

      fireEvent.click(checkbox('Create missing directories a policy grants'));
      await waitFor(() => {
        expect(mockLocalmost.settings.set).toHaveBeenCalledWith({
          jobEnvironment: { ...DEFAULTS, toolShims: false, createMissingGrantedDirs: false },
        });
      });
    });

    it('shows the defaults while the store holds neither yet', async () => {
      seedZubridge({ config: {} });
      renderWithProviders(<SettingsPage onBack={jest.fn()} />);

      await waitFor(() => expect(runningJobsSelect().value).toBe('finish'));
      for (const [, label] of CONVENIENCES) expect(checkbox(label).checked).toBe(true);
    });
  });
});

describe('the Isolation section', () => {
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

  const checkbox = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
  const group = (label: string) => checkbox(label).closest('div') as HTMLElement;

  it('has a checkbox per type, seatbelt allowed by default and the others not available in this build', async () => {
    renderWithProviders(<SettingsPage onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Isolation')).toBeInTheDocument());

    expect(checkbox('Seatbelt sandbox').checked).toBe(true);
    expect(checkbox('Seatbelt sandbox').disabled).toBe(false);
    for (const label of ['Service account', 'macOS VM']) {
      expect({ label, checked: checkbox(label).checked, disabled: checkbox(label).disabled }).toEqual({
        label,
        checked: false,
        disabled: true,
      });
      expect(group(label)).toHaveTextContent('Not available in this build');
    }
    expect(group('Seatbelt sandbox')).not.toHaveTextContent('Not available in this build');
    // The service account is headless: say so where it would be chosen.
    expect(group('Service account')).toHaveTextContent(/Headless only/);
  });

  it("says this Mac's set is the guard, and the repository's list only orders it", async () => {
    renderWithProviders(<SettingsPage onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Isolation')).toBeInTheDocument());

    const section = screen.getByText('Isolation').closest('section') as HTMLElement;
    expect(section).toHaveTextContent(/first type in its repository's isolation: list that is allowed here and available/);
    expect(section).toHaveTextContent(/A job whose repository lists none of them is refused/);
  });

  it('turns seatbelt off and on, sending the allowed list', async () => {
    renderWithProviders(<SettingsPage onBack={jest.fn()} />);
    await waitFor(() => expect(checkbox('Seatbelt sandbox').checked).toBe(true));

    fireEvent.click(checkbox('Seatbelt sandbox'));
    await waitFor(() => expect(mockLocalmost.settings.set).toHaveBeenLastCalledWith({ isolation: { allowed: [] } }));
    await waitFor(() => expect(checkbox('Seatbelt sandbox').checked).toBe(false));
    // Nothing allowed: every job is refused, and the page says so.
    expect(screen.getByText(/No type is allowed: every job is refused/)).toBeInTheDocument();

    fireEvent.click(checkbox('Seatbelt sandbox'));
    await waitFor(() => expect(mockLocalmost.settings.set).toHaveBeenLastCalledWith({ isolation: { allowed: ['seatbelt'] } }));
  });

  it('shows the saved set from the store, and sends only types this build can run', async () => {
    // A config a later build wrote may allow the VM; it allows nothing here,
    // and turning seatbelt on or off does not send it back.
    seedZubridge({ config: { isolation: { allowed: ['macos-vm'] } } });
    renderWithProviders(<SettingsPage onBack={jest.fn()} />);
    await waitFor(() => expect(checkbox('Seatbelt sandbox').checked).toBe(false));
    expect(checkbox('macOS VM').checked).toBe(false);

    fireEvent.click(checkbox('Seatbelt sandbox'));
    await waitFor(() => expect(mockLocalmost.settings.set).toHaveBeenLastCalledWith({ isolation: { allowed: ['seatbelt'] } }));
  });
});
