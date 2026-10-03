import React, { useState, useEffect } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark, faLightbulb, faMoon, faDesktop } from '@fortawesome/free-solid-svg-icons';
import { SleepProtection, BatteryPauseThreshold, SANDBOX_POLICY_LEVEL_DESCRIPTIONS } from '../../shared/types';
import { ResourcePauseConfig, JobEnvironmentConfig } from '../../shared/job-preferences';
import { ISOLATION_DESCRIPTIONS, ISOLATION_TYPES, availableIsolationTypes } from '../../shared/isolation';
import { GITHUB_APP_SETTINGS_URL, PRIVACY_POLICY_URL, REPOSITORY_URL } from '../../shared/constants';
import { useAppConfig, useRunner, useUpdate } from '../contexts';
import UserFilterSettings from './UserFilterSettings';
import PolicyApprovals from './PolicyApprovals';
import styles from './SettingsPage.module.css';
import shared from '../styles/shared.module.css';

/**
 * The job-environment conveniences, in the order the page shows them: each
 * a checkbox, on by default but the Swift Build link-temp grant. See
 * docs/roadmap/job-environment.md.
 */
const JOB_ENVIRONMENT_OPTIONS: ReadonlyArray<{
  key: keyof JobEnvironmentConfig;
  label: string;
  hint: string;
  /** What the current setting means for a job, where that is not said in the hint. */
  stateHints?: { on: string; off: string };
}> = [
  {
    key: 'toolShims',
    label: "Turn off SwiftPM's and Xcode's own sandbox",
    hint:
      'Puts swift and xcodebuild shims first on the job\'s PATH, adding --disable-sandbox and ' +
      '-IDEPackageSupportDisableManifestSandbox=YES: macOS will not start their sandbox inside the job\'s. ' +
      'Off, a package manifest not compiled before fails to build. The docker CLI stays on PATH either way.',
  },
  {
    key: 'javaToolOptions',
    label: 'Set JAVA_TOOL_OPTIONS for JVMs',
    hint:
      'Gives JVMs a temp directory in the job\'s, IPv4 only, and the job\'s proxy with its credentials, ' +
      'which every JVM prints to the job\'s log. A workflow that sets JAVA_TOOL_OPTIONS itself replaces it.',
  },
  {
    key: 'perJobTempDir',
    label: 'Give each job its own temp directory for Foundation',
    hint:
      'A directory of the job\'s own in the per-user temp directory, named by DIRHELPER_USER_DIR_SUFFIX and ' +
      'removed after the job, for NSTemporaryDirectory() and atomic writes such as SwiftPM\'s and ' +
      'xcodebuild\'s. Off, those writes fail.',
  },
  {
    key: 'createMissingGrantedDirs',
    label: 'Create missing directories a policy grants',
    hint:
      'Before a job, creates a missing directory a write grant names under your home, which the job ' +
      'cannot create itself: empty, one level at a time, never through a link, never in a credential ' +
      'location.',
    stateHints: {
      on: 'On: there is nothing to create yourself before a job.',
      off:
        'Off: a directory a policy grants under your home, or one above it, that does not exist stays ' +
        'missing, and you must create it yourself before the job runs, or the job fails with "Operation not ' +
        'permitted" at its first write there.',
    },
  },
  {
    key: 'swiftBuildLinkTemp',
    label: 'Let Swift Build link in the shared temp directory',
    // Both cases, whatever the toggle's state: the risk of turning it on is
    // read before it is taken.
    hint:
      'Swift 6.4\'s default build system links in a TemporaryDirectory.XXXXXX directory it makes in the ' +
      'per-user temp directory, whatever the job\'s TMPDIR says. On, a job may create ' +
      '<T>/TemporaryDirectory.XXXXXX names in that shared directory, which your own SwiftPM and Xcode also use ' +
      'for manifest executables, so a job could race to replace one before it runs. Off (the default), Swift ' +
      '6.4\'s default build system fails to link inside a job; a workflow can pass swift build --build-system ' +
      'native, or the repository can use the macOS VM isolation type once it is available.',
  },
];

interface SettingsPageProps {
  onBack: () => void;
  scrollToSection?: string;
  onOpenTargets?: () => void;
}

const SettingsPage: React.FC<SettingsPageProps> = ({ onBack, scrollToSection, onOpenTargets }) => {
  // App config from context
  const {
    theme,
    setTheme,
    maxLogScrollback,
    setMaxLogScrollback,
    maxJobHistory,
    setMaxJobHistory,
    sleepProtection,
    setSleepProtection,
    sleepProtectionConsented,
    consentToSleepProtection,
    logLevel,
    setLogLevel,
    runnerLogLevel,
    setRunnerLogLevel,
    toolCacheLocation,
    setToolCacheLocation,
    userFilter,
    setUserFilter,
    power,
    setPauseOnBattery,
    setPauseOnVideoCall,
    notifications,
    setNotifyOnPause,
    setNotifyOnJobEvents,
    resourcePause,
    setResourcePauseRunningJobs,
    jobEnvironment,
    setJobEnvironmentOption,
    isolation,
    setIsolationAllowed,
  } = useAppConfig();

  // Runner state from context
  const {
    user,
    isAuthenticating,
    deviceCode,
    login,
    logout,
    authExpired,
    refreshAuthExpiry,
    isDownloaded,
    runnerVersion,
    availableVersions,
    selectedVersion,
    setSelectedVersion,
    downloadProgress,
    isLoadingVersions,
    downloadRunner,
    isConfigured,
    runnerConfig,
    updateRunnerConfig,
    targets,
    isInitialLoading,
    error,
  } = useRunner();

  // Update state from context
  const { status: updateStatus, settings: updateSettings, setSettings: setUpdateSettings, checkForUpdates, isChecking, lastChecked } = useUpdate();

  // Local UI state
  const [showSleepConsentDialog, setShowSleepConsentDialog] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [pendingSleepSetting, setPendingSleepSetting] = useState<SleepProtection | null>(null);
  const [avatarError, setAvatarError] = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [hideOnStart, setHideOnStart] = useState(false);
  const [showCopiedNotice, setShowCopiedNotice] = useState(false);

  // Show copied notice when device code is copied, auto-hide after 4s
  useEffect(() => {
    if (deviceCode?.copiedToClipboard) {
      setShowCopiedNotice(true);
      const timer = setTimeout(() => setShowCopiedNotice(false), 4000);
      return () => clearTimeout(timer);
    } else {
      setShowCopiedNotice(false);
    }
  }, [deviceCode?.copiedToClipboard]);

  // Load startup settings
  useEffect(() => {
    const loadStartupSettings = async () => {
      const settings = await window.localmost.settings.get();
      setLaunchAtLogin((settings.launchAtLogin as boolean | undefined) ?? false);
      setHideOnStart((settings.hideOnStart as boolean | undefined) ?? false);
    };
    loadStartupSettings();
  }, []);

  // Scroll to section when specified
  useEffect(() => {
    if (scrollToSection) {
      const attemptScroll = () => {
        const element = document.getElementById(scrollToSection);
        if (element) {
          setTimeout(() => {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            element.classList.add('highlight');
            setTimeout(() => {
              element.classList.remove('highlight');
            }, 1500);
          }, 100);
          return true;
        }
        return false;
      };

      if (!attemptScroll()) {
        let attempts = 0;
        const maxAttempts = 10;
        const interval = setInterval(() => {
          attempts++;
          if (attemptScroll() || attempts >= maxAttempts) {
            clearInterval(interval);
          }
        }, 100);
      }
    }
  }, [scrollToSection, user, isDownloaded]);

  const handleLogin = async () => {
    setAvatarError(false);
    await login();
  };

  const handleSleepProtectionChange = (newValue: SleepProtection) => {
    if (newValue !== 'never' && !sleepProtectionConsented) {
      setPendingSleepSetting(newValue);
      setShowSleepConsentDialog(true);
    } else {
      setSleepProtection(newValue);
    }
  };

  return (
    <div className={styles.settingsPage} data-testid="settings-page">
      <div className={shared.pageHeader}>
        <h2>Settings</h2>
        <button className={shared.btnIcon} onClick={onBack} title="Close settings">
          <FontAwesomeIcon icon={faXmark} />
        </button>
      </div>

      <div className={styles.settingsContent} data-testid="page-content">
        {/* Startup Section */}
        <section className={styles.settingsSection} data-testid="settings-section">
          <h3>Startup</h3>
          <div className={shared.formGroup}>
            <label className={shared.toggleRow}>
              <input
                type="checkbox"
                checked={launchAtLogin}
                onChange={(e) => {
                  const value = e.target.checked;
                  setLaunchAtLogin(value);
                  window.localmost.settings.set({ launchAtLogin: value });
                }}
              />
              <span>Start localmost when you sign in</span>
            </label>
          </div>
          <div className={shared.formGroup}>
            <label className={shared.toggleRow}>
              <input
                type="checkbox"
                checked={hideOnStart}
                onChange={(e) => {
                  const value = e.target.checked;
                  setHideOnStart(value);
                  window.localmost.settings.set({ hideOnStart: value });
                }}
              />
              <span>Hide localmost when it starts</span>
            </label>
          </div>
        </section>

        {/* GitHub Account Section */}
        <section className={styles.settingsSection} data-testid="settings-section">
          <h3>GitHub Account</h3>
          {user ? (
            <div className={styles.accountInfo}>
              {user.avatar_url && !avatarError ? (
                <img
                  src={user.avatar_url}
                  alt={user.login}
                  className={styles.avatar}
                  onError={() => setAvatarError(true)}
                />
              ) : (
                <div className={styles.avatarFallback}>
                  {(user.name || user.login).charAt(0).toUpperCase()}
                </div>
              )}
              <div className={styles.accountDetails}>
                <span className={styles.accountName}>{user.name || user.login}</span>
                <a
                  href={GITHUB_APP_SETTINGS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.accountLoginLink}
                >
                  @{user.login}
                </a>
              </div>
              {authExpired && deviceCode && (
                // Reconnect starts the device flow from here, so the code has
                // to be shown here too: the panel below lives in the
                // signed-out branch, which an expired session never reaches.
                // Without this the browser opened and asked for a code the
                // app never displayed.
                <div className={styles.codeWithCopied}>
                  <code className={styles.userCodeSmall}>{deviceCode.userCode}</code>
                  {showCopiedNotice && <span className={styles.copiedBadge}>Copied!</span>}
                  <button
                    className={shared.btnSecondary}
                    onClick={() => window.localmost.github.cancelAuth()}
                  >
                    Cancel
                  </button>
                </div>
              )}

              {authExpired && !deviceCode && (
                // Additive: the account still renders exactly as before, with
                // a badge and a way out beside it. Nothing about what the app
                // considers its auth state changes.
                <>
                  <span className={styles.expiredNotice}>Session expired</span>
                  <button
                    className={shared.btnPrimary}
                    disabled={isReconnecting}
                    onClick={async () => {
                      setIsReconnecting(true);
                      try {
                        // A refresh first: the session may simply have been
                        // re-authorised, and then nothing is asked of them.
                        const { recovered } = await window.localmost.github.reconnect();
                        if (!recovered) await handleLogin();
                        // The flag is read when the provider mounts, so
                        // without this the badge outlived the fix and the app
                        // had to be quit and reopened.
                        await refreshAuthExpiry();
                      } finally {
                        setIsReconnecting(false);
                      }
                    }}
                  >
                    {isReconnecting ? 'Reconnecting...' : 'Reconnect'}
                  </button>
                </>
              )}
              <button className={shared.btnSecondary} onClick={logout}>
                Sign Out
              </button>
            </div>
          ) : (
            <div className={styles.authSection}>
              {!isAuthenticating && !deviceCode && (
                <button className={shared.btnPrimary} onClick={handleLogin}>
                  Sign in with GitHub
                </button>
              )}

              {deviceCode && (
                <div className={styles.deviceCodeCompact}>
                  <p>Enter code on GitHub:</p>
                  <div className={styles.codeWithCopied}>
                    <code className={styles.userCodeSmall}>{deviceCode.userCode}</code>
                    {showCopiedNotice && (
                      <span className={styles.copiedBadge}>Copied!</span>
                    )}
                  </div>
                  <div className={shared.waitingIndicator}>
                    <div className={shared.spinner} />
                    <span>Waiting...</span>
                  </div>
                  <button
                    className={shared.btnSecondary}
                    onClick={() => window.localmost.github.cancelAuth()}
                  >
                    Cancel
                  </button>
                </div>
              )}

              {isAuthenticating && !deviceCode && (
                <div className={shared.waitingIndicator}>
                  <div className={shared.spinner} />
                  <span>Connecting...</span>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Runner Download Section */}
        <section className={styles.settingsSection} data-testid="settings-section">
          <div className={styles.sectionHeaderRow}>
            <h3>Runner Binary</h3>
            {isDownloaded && runnerVersion.version && (
              <a
                href={runnerVersion.url || '#'}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.versionLink}
              >
                v{runnerVersion.version}
              </a>
            )}
          </div>
          <div className={styles.downloadSection}>
            {downloadProgress ? (
              <div className={styles.downloadProgress}>
                <div className={styles.progressBar}>
                  <div
                    className={styles.progressFill}
                    style={{ width: `${downloadProgress.percent}%` }}
                  />
                </div>
                <p className={styles.progressMessage}>{downloadProgress.message}</p>
              </div>
            ) : (
              <>
                <div className={shared.formGroup}>
                  <label>Version</label>
                  {isLoadingVersions ? (
                    <div className={shared.waitingIndicator}>
                      <div className={shared.spinner} />
                      <span>Loading versions...</span>
                    </div>
                  ) : (
                    <select
                      value={selectedVersion}
                      onChange={(e) => setSelectedVersion(e.target.value)}
                    >
                      {availableVersions.map((release) => {
                        const isInstalled = isDownloaded && runnerVersion.version === release.version;
                        const isLatest = availableVersions[0]?.version === release.version;
                        const labels = [];
                        if (isLatest) labels.push('latest');
                        if (isInstalled) labels.push('installed');
                        const labelStr = labels.length > 0 ? ` (${labels.join(', ')})` : '';

                        return (
                          <option key={release.version} value={release.version}>
                            v{release.version}{labelStr}
                          </option>
                        );
                      })}
                    </select>
                  )}
                </div>
                {!isInitialLoading && (!isDownloaded || selectedVersion !== runnerVersion.version) && (
                  <button
                    className={shared.btnPrimary}
                    onClick={downloadRunner}
                    disabled={isLoadingVersions || !selectedVersion}
                  >
                    {isDownloaded ? 'Change Version' : 'Download Runner'}
                  </button>
                )}
              </>
            )}
          </div>
        </section>

        {/* Runner Configuration Section */}
        {user && isDownloaded && (
          <section id="runner-config-section" className={styles.settingsSection} data-testid="settings-section">
            <h3>Runner Configuration</h3>

            {onOpenTargets && (
              <div className={shared.formGroup}>
                <button
                  className={shared.btnPrimary}
                  onClick={onOpenTargets}
                >
                  Manage Targets
                </button>
                {targets.length > 0 ? (
                  <p className={shared.formHint}>
                    {targets.length === 1
                      ? `${targets[0].type}: ${targets[0].displayName}`
                      : `${targets.length} targets: ${targets.map(t => t.displayName).join(', ')}`}
                  </p>
                ) : (
                  <p className={shared.formHint}>
                    Add repositories or organizations to receive jobs from.
                  </p>
                )}
              </div>
            )}

            <div className={shared.formGroup}>
              <label>Runner Name</label>
              <input
                type="text"
                value={runnerConfig.runnerName}
                onChange={(e) => updateRunnerConfig({ runnerName: e.target.value })}
                placeholder="my-local-runner"
              />
              <p className={shared.formHint}>
                Base name for runner registrations with GitHub.
              </p>
            </div>

            <div className={shared.formGroup}>
              <label>Labels (comma-separated)</label>
              <input
                type="text"
                value={runnerConfig.labels}
                onChange={(e) => updateRunnerConfig({ labels: e.target.value })}
                placeholder="self-hosted,macOS"
              />
            </div>

            <div className={shared.formGroup}>
              <label>Parallelism</label>
              <div className={styles.parallelismControl}>
                <input
                  type="range"
                  min="1"
                  max="8"
                  value={runnerConfig.runnerCount}
                  onChange={(e) => updateRunnerConfig({ runnerCount: parseInt(e.target.value, 10) })}
                />
                <span className={styles.parallelismValue}>{runnerConfig.runnerCount} runner{runnerConfig.runnerCount > 1 ? 's' : ''}</span>
              </div>
              <p className={shared.formHint}>
                Maximum concurrent jobs across all targets.
              </p>
            </div>

            <div className={shared.formGroup}>
              <label>Tool cache</label>
              <select
                value={toolCacheLocation}
                onChange={(e) => setToolCacheLocation(e.target.value as 'persistent' | 'per-sandbox')}
              >
                <option value="persistent">Persistent (recommended)</option>
                <option value="per-sandbox">Per-sandbox</option>
              </select>
              <p className={shared.formHint}>
                Persistent caches tools like Node.js across restarts, separately for each repository or organization, shared by all of its jobs (pull requests and, for an organization, all of its repositories). Per-sandbox rebuilds each time (slower, but no job can leave anything for the next).
              </p>
            </div>
          </section>
        )}

        {/* Job Security Section */}
        {user && isConfigured && (
          <section className={styles.settingsSection} data-testid="settings-section">
            <h3>Job Security</h3>

            {/* Repository policy approvals */}
            <div className={styles.subsection}>
              <h4>Repository Policies</h4>
              <PolicyApprovals />
            </div>

            {/* Sandbox Policy Subsection */}
            <div className={styles.subsection}>
              <h4>Sandbox Policy</h4>
              <p className={shared.formHint}>
                Each repository declares its own policy level in its{' '}
                <code>.localmostrc</code>, alongside the hosts and paths it
                needs. A repository that declares none runs strict. Changing the
                level is a policy change like any other, so it appears in the
                approval above before it takes effect.
              </p>
              <ul className={shared.formHint}>
                {(['strict', 'moderate', 'permissive'] as const).map((level) => (
                  <li key={level}>
                    <strong>{SANDBOX_POLICY_LEVEL_DESCRIPTIONS[level].label}</strong>
                    {' — '}
                    {SANDBOX_POLICY_LEVEL_DESCRIPTIONS[level].description}
                  </li>
                ))}
              </ul>
            </div>

            {/* User Filtering Subsection */}
            <div className={styles.subsection}>
              <h4>User Filtering</h4>
              <UserFilterSettings
                userFilter={userFilter}
                currentUserLogin={user.login}
                onFilterChange={setUserFilter}
              />
            </div>
          </section>
        )}

        {/* Job Environment Section */}
        <section id="job-environment-section" className={styles.settingsSection} data-testid="settings-section">
          <h3>Job Environment</h3>
          <p className={shared.formHint}>
            What localmost adds to each job&apos;s environment so common tools work in its sandbox. A change
            applies to jobs that start after it.
          </p>
          {JOB_ENVIRONMENT_OPTIONS.map(({ key, label, hint, stateHints }) => (
            <div key={key} className={shared.formGroup}>
              <label className={shared.toggleRow}>
                <input
                  type="checkbox"
                  checked={jobEnvironment[key]}
                  onChange={(e) => setJobEnvironmentOption(key, e.target.checked)}
                />
                <span>{label}</span>
              </label>
              <p className={shared.formHint}>{hint}</p>
              {stateHints && (
                <p className={shared.formHint}>{jobEnvironment[key] ? stateHints.on : stateHints.off}</p>
              )}
            </div>
          ))}
        </section>

        {/* Isolation Section */}
        <section id="isolation-section" className={styles.settingsSection} data-testid="settings-section">
          <h3>Isolation</h3>
          <p className={shared.formHint}>
            How a job is kept from the rest of your Mac. Each job runs under the first type in its
            repository&apos;s isolation: list that is checked here and available in this build (a repository that
            declares none accepts any, strongest first). If none qualifies, the job is refused, never run under a
            type its repository did not list.
          </p>
          {ISOLATION_TYPES.map((type) => {
            const available = availableIsolationTypes().includes(type);
            const { label, description } = ISOLATION_DESCRIPTIONS[type];
            return (
              <div key={type} className={shared.formGroup}>
                <label className={shared.toggleRow}>
                  <input
                    type="checkbox"
                    checked={available && isolation.allowed.includes(type)}
                    disabled={!available}
                    onChange={(e) => setIsolationAllowed(type, e.target.checked)}
                  />
                  <span>{label}</span>
                </label>
                <p className={shared.formHint}>{description}</p>
                {!available && <p className={shared.formHint}>Not available in this build.</p>}
              </div>
            );
          })}
          {!isolation.allowed.some((type) => availableIsolationTypes().includes(type)) && (
            <p className={shared.formHint}>No type is allowed: every job is refused.</p>
          )}
        </section>

        {/* Power Section */}
        <section id="power-section" className={styles.settingsSection} data-testid="settings-section">
          <h3>Power</h3>
          <div className={shared.formGroup}>
            <label>Prevent sleep</label>
            <select
              value={sleepProtection}
              onChange={(e) => handleSleepProtectionChange(e.target.value as SleepProtection)}
            >
              <option value="never">Never</option>
              <option value="when-busy">When running a job</option>
              <option value="always">Always</option>
            </select>
            <p className={shared.formHint}>
              Prevents your Mac from sleeping while GitHub Actions jobs are running, ensuring jobs complete successfully.
            </p>
          </div>
          <div className={shared.formGroup}>
            <label>Pause when using battery</label>
            <select
              value={power.pauseOnBattery}
              onChange={(e) => setPauseOnBattery(e.target.value as BatteryPauseThreshold)}
            >
              <option value="never">Never</option>
              <option value="<25%">Below 25%</option>
              <option value="<50%">Below 50%</option>
              <option value="<75%">Below 75%</option>
              <option value="always">Always</option>
            </select>
            <p className={shared.formHint}>
              Automatically pause runners when your Mac is on battery power. Jobs will fall back to GitHub-hosted runners.
            </p>
          </div>
          <div className={shared.formGroup}>
            <label className={shared.toggleRow}>
              <input
                type="checkbox"
                checked={power.pauseOnVideoCall}
                onChange={(e) => setPauseOnVideoCall(e.target.checked)}
              />
              <span>Pause during video calls</span>
            </label>
            <p className={shared.formHint}>
              Detects camera usage and pauses runners during video calls. Resumes 60 seconds after the call ends.
            </p>
          </div>
          <div className={shared.formGroup}>
            <label htmlFor="resource-pause-running-jobs">Running jobs when a pause begins</label>
            <select
              id="resource-pause-running-jobs"
              value={resourcePause.runningJobs}
              onChange={(e) => setResourcePauseRunningJobs(e.target.value as ResourcePauseConfig['runningJobs'])}
            >
              <option value="finish">Let them finish</option>
              <option value="stop">Stop them</option>
            </select>
            <p className={shared.formHint}>
              Either way the runner takes no new job while paused. Stopping them stops the workers at once, and
              their jobs fail on GitHub. Applies from the next pause.
            </p>
          </div>
        </section>

        {/* Notifications Section */}
        <section className={styles.settingsSection} data-testid="settings-section">
          <h3>Notifications</h3>
          <div className={shared.formGroup}>
            <label className={shared.toggleRow}>
              <input
                type="checkbox"
                checked={notifications.notifyOnPause}
                onChange={(e) => setNotifyOnPause(e.target.checked)}
              />
              <span>Notify when pausing/resuming</span>
            </label>
            <p className={shared.formHint}>
              Show a notification when runners are paused or resumed due to resource constraints.
            </p>
          </div>
          <div className={shared.formGroup}>
            <label className={shared.toggleRow}>
              <input
                type="checkbox"
                checked={notifications.notifyOnJobEvents}
                onChange={(e) => setNotifyOnJobEvents(e.target.checked)}
              />
              <span>Notify on job start/end</span>
            </label>
            <p className={shared.formHint}>
              Show a notification when a GitHub Actions job starts or completes on your runner.
            </p>
          </div>
        </section>

        {/* Sleep Protection Consent Dialog */}
        {showSleepConsentDialog && (
          <div className={shared.modalOverlay}>
            <div className={shared.modalDialog}>
              <h3>Enable Sleep Prevention?</h3>
              <p>
                This feature prevents your Mac from sleeping while jobs are running.
                Without it, system sleep may interrupt active jobs.
              </p>
              <p>
                <strong>What this does:</strong>
              </p>
              <ul>
                <li>Keeps your Mac awake during job execution</li>
                <li>Automatically releases when jobs complete</li>
                <li>Can be changed anytime in Settings</li>
              </ul>
              <div className={shared.modalActions}>
                <button
                  className={shared.btnSecondary}
                  onClick={() => {
                    setShowSleepConsentDialog(false);
                    setPendingSleepSetting(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className={shared.btnPrimary}
                  onClick={() => {
                    if (pendingSleepSetting) {
                      consentToSleepProtection();
                      setSleepProtection(pendingSleepSetting);
                    }
                    setShowSleepConsentDialog(false);
                    setPendingSleepSetting(null);
                  }}
                >
                  Enable
                </button>
              </div>
            </div>
          </div>
        )}

        {/* History Section */}
        <section className={styles.settingsSection} data-testid="settings-section">
          <h3>History</h3>
          <div className={shared.formGroup}>
            <label>Max recent jobs</label>
            <select
              value={maxJobHistory}
              onChange={(e) => setMaxJobHistory(parseInt(e.target.value, 10))}
            >
              <option value={5}>5 jobs</option>
              <option value={10}>10 jobs</option>
              <option value={20}>20 jobs</option>
              <option value={30}>30 jobs</option>
              <option value={50}>50 jobs</option>
            </select>
          </div>
          <div className={shared.formGroup}>
            <label>Max log scrollback</label>
            <select
              value={maxLogScrollback}
              onChange={(e) => setMaxLogScrollback(parseInt(e.target.value, 10))}
            >
              <option value={100}>100 lines</option>
              <option value={250}>250 lines</option>
              <option value={500}>500 lines</option>
              <option value={1000}>1,000 lines</option>
              <option value={2500}>2,500 lines</option>
              <option value={5000}>5,000 lines</option>
            </select>
          </div>
          <div className={shared.formGroup}>
            <label>localmost log level</label>
            <select
              value={logLevel}
              onChange={(e) => setLogLevel(e.target.value as 'debug' | 'info' | 'warn' | 'error')}
            >
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warning</option>
              <option value="error">Error</option>
            </select>
          </div>
          <div className={shared.formGroup}>
            <label>Runner log level</label>
            <select
              value={runnerLogLevel}
              onChange={(e) => setRunnerLogLevel(e.target.value as 'debug' | 'info' | 'warn' | 'error')}
            >
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warning</option>
              <option value="error">Error</option>
            </select>
            <p className={shared.formHint}>
              At Debug, with the localmost log level also at Debug, the runner's diagnostic trace (job names, runner URLs) is written to ~/.localmost/logs.
            </p>
          </div>
        </section>

        {/* Appearance Section */}
        <section className={styles.settingsSection} data-testid="settings-section">
          <h3>Appearance</h3>
          <div className={styles.themeSelector}>
            <button
              className={theme === 'light' ? styles.themeOptionActive : styles.themeOption}
              onClick={() => setTheme('light')}
            >
              <FontAwesomeIcon icon={faLightbulb} />
              <span>Light</span>
            </button>
            <button
              className={theme === 'dark' ? styles.themeOptionActive : styles.themeOption}
              onClick={() => setTheme('dark')}
            >
              <FontAwesomeIcon icon={faMoon} />
              <span>Dark</span>
            </button>
            <button
              className={theme === 'auto' ? styles.themeOptionActive : styles.themeOption}
              onClick={() => setTheme('auto')}
            >
              <FontAwesomeIcon icon={faDesktop} />
              <span>Auto</span>
            </button>
          </div>
        </section>

        {/* Updates Section */}
        <section className={styles.settingsSection} data-testid="settings-section">
          <div className={styles.sectionHeaderRow}>
            <h3>Updates</h3>
            <span className={styles.versionLink}>v{updateStatus.currentVersion}</span>
          </div>
          <div className={shared.formGroup}>
            <label className={shared.toggleRow}>
              <input
                type="checkbox"
                checked={updateSettings.autoCheck}
                onChange={(e) => setUpdateSettings({ ...updateSettings, autoCheck: e.target.checked })}
              />
              <span>Check for updates automatically</span>
            </label>
          </div>
          <div className={styles.updateCheckRow}>
            <button
              className={shared.btnSecondary}
              onClick={checkForUpdates}
              disabled={isChecking}
            >
              {isChecking ? 'Checking...' : 'Check for Updates'}
            </button>
            {updateStatus.status === 'available' && (
              <span className={styles.updateAvailable}>
                Version {updateStatus.availableVersion} available
              </span>
            )}
            {updateStatus.status === 'downloaded' && (
              <span className={styles.updateReady}>
                Update ready to install
              </span>
            )}
            {updateStatus.status === 'idle' && lastChecked && (
              <span className={styles.upToDate}>
                ✓ Up to date
              </span>
            )}
          </div>
        </section>

        {/* About Section */}
        <section className={styles.settingsSection} data-testid="settings-section">
          <h3>About</h3>
          <div className={styles.aboutLinks}>
            <a
              href={PRIVACY_POLICY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.aboutLink}
            >
              Privacy Policy
            </a>
            <a
              href={REPOSITORY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.aboutLink}
            >
              View on GitHub
            </a>
          </div>
        </section>

        {error && <div className={shared.errorMessage}>{error}</div>}
      </div>
    </div>
  );
};

export default SettingsPage;
