import React, { useState, useEffect } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark, faLightbulb, faMoon, faDesktop } from '@fortawesome/free-solid-svg-icons';
import { SleepProtection, BatteryPauseThreshold } from '../../shared/types';
import { GITHUB_APP_SETTINGS_URL, PRIVACY_POLICY_URL, REPOSITORY_URL } from '../../shared/constants';
import { useAppConfig, useRunner, useUpdate } from '../contexts';
import UserFilterSettings from './UserFilterSettings';
import styles from './SettingsPage.module.css';
import shared from '../styles/shared.module.css';

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
    preserveWorkDir,
    setPreserveWorkDir,
    toolCacheLocation,
    setToolCacheLocation,
    userFilter,
    setUserFilter,
    resourceAware,
    setPauseOnBattery,
    setPauseOnVideoCall,
    setNotifyOnPause,
  } = useAppConfig();

  // Runner state from context
  const {
    user,
    isAuthenticating,
    deviceCode,
    login,
    logout,
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
  const [pendingSleepSetting, setPendingSleepSetting] = useState<SleepProtection | null>(null);
  const [avatarError, setAvatarError] = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [hideOnStart, setHideOnStart] = useState(false);

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
    <div className={styles.settingsPage}>
      <div className={shared.pageHeader}>
        <h2>Settings</h2>
        <button className={shared.btnIcon} onClick={onBack} title="Close settings">
          <FontAwesomeIcon icon={faXmark} />
        </button>
      </div>

      <div className={styles.settingsContent}>
        {/* Startup Section */}
        <section className={styles.settingsSection}>
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
        <section className={styles.settingsSection}>
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
                  <code className={styles.userCodeSmall}>{deviceCode.userCode}</code>
                  <div className={shared.waitingIndicator}>
                    <div className={shared.spinner} />
                    <span>Waiting...</span>
                  </div>
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
        <section className={styles.settingsSection}>
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
          <section id="runner-config-section" className={styles.settingsSection}>
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
                  max="16"
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
                Persistent caches tools like Node.js across restarts. Per-sandbox rebuilds each time (slower but cleaner).
              </p>
            </div>

            <div className={shared.formGroup}>
              <label>Cache work directory</label>
              <select
                value={preserveWorkDir}
                onChange={(e) => setPreserveWorkDir(e.target.value as 'never' | 'session' | 'always')}
              >
                <option value="never">Never (recommended)</option>
                <option value="session">During session</option>
                <option value="always">Always</option>
              </select>
              <p className={shared.formHint}>
                Preserve workflow _work directory to cache dependencies like node_modules. "During session" clears on app start/quit.
              </p>
            </div>
          </section>
        )}

        {/* User Filter Section */}
        {user && isConfigured && (
          <section className={styles.settingsSection}>
            <h3>Job Filtering</h3>
            <UserFilterSettings
              userFilter={userFilter}
              currentUserLogin={user.login}
              onFilterChange={setUserFilter}
            />
          </section>
        )}

        {/* Power Section */}
        <section id="power-section" className={styles.settingsSection}>
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
        </section>

        {/* Resource Awareness Section */}
        <section id="resource-section" className={styles.settingsSection}>
          <h3>Resource Awareness</h3>
          <div className={shared.formGroup}>
            <label>Pause when using battery</label>
            <select
              value={resourceAware.pauseOnBattery}
              onChange={(e) => setPauseOnBattery(e.target.value as BatteryPauseThreshold)}
            >
              <option value="no">No</option>
              <option value="<25%">Below 25%</option>
              <option value="<50%">Below 50%</option>
              <option value="<75%">Below 75%</option>
            </select>
            <p className={shared.formHint}>
              Automatically pause runners when your Mac is on battery power. Jobs will fall back to GitHub-hosted runners.
            </p>
          </div>
          <div className={shared.formGroup}>
            <label className={shared.toggleRow}>
              <input
                type="checkbox"
                checked={resourceAware.pauseOnVideoCall}
                onChange={(e) => setPauseOnVideoCall(e.target.checked)}
              />
              <span>Pause during video calls</span>
            </label>
            <p className={shared.formHint}>
              Detects camera usage and pauses runners during video calls. Resumes 60 seconds after the call ends.
            </p>
          </div>
          <div className={shared.formGroup}>
            <label className={shared.toggleRow}>
              <input
                type="checkbox"
                checked={resourceAware.notifyOnPause}
                onChange={(e) => setNotifyOnPause(e.target.checked)}
              />
              <span>Notify when pausing/resuming</span>
            </label>
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
        <section className={styles.settingsSection}>
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
          </div>
        </section>

        {/* Appearance Section */}
        <section className={styles.settingsSection}>
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
        <section className={styles.settingsSection}>
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
        <section className={styles.settingsSection}>
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
