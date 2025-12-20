import React, { useState, useEffect } from 'react';
import { GitHubRepo, DownloadProgress, DeviceCodeInfo } from '../../shared/types';
import styles from './SetupWizard.module.css';
import shared from '../styles/shared.module.css';

interface SetupWizardProps {
  onComplete: () => void;
}

type WizardStep = 'auth' | 'download' | 'configure';

const SetupWizard: React.FC<SetupWizardProps> = ({ onComplete }) => {
  const [step, setStep] = useState<WizardStep>('auth');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Auth step - Device Flow
  const [deviceCode, setDeviceCode] = useState<DeviceCodeInfo | null>(null);
  const [isWaitingForAuth, setIsWaitingForAuth] = useState(false);

  // Download step
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);

  // Configure step
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [runnerName, setRunnerName] = useState('');
  const [labels, setLabels] = useState('self-hosted,macOS');

  useEffect(() => {
    // Set default runner name
    setRunnerName(`localmost-${Math.random().toString(36).substring(2, 8)}`);

    // Check if already authenticated
    window.localmost.github.getAuthStatus().then(async (status: { isAuthenticated: boolean }) => {
      if (status.isAuthenticated) {
        // Already logged in - skip to download or configure
        const isDownloaded = await window.localmost.runner.isDownloaded();
        if (isDownloaded) {
          setStep('configure');
          loadRepos();
        } else {
          setStep('download');
        }
      }
    });
  }, []);

  useEffect(() => {
    // Subscribe to device code updates
    return window.localmost.github.onDeviceCode((info: DeviceCodeInfo) => {
      setDeviceCode(info);
    });
  }, []);

  useEffect(() => {
    // Subscribe to download progress
    return window.localmost.runner.onDownloadProgress((progress: DownloadProgress) => {
      setDownloadProgress(progress);
      if (progress.phase === 'complete') {
        setStep('configure');
        loadRepos();
      } else if (progress.phase === 'error') {
        setError(progress.message);
        setIsLoading(false);
      }
    });
  }, []);

  const loadRepos = async () => {
    const result = await window.localmost.github.getRepos();
    if (result.success && result.repos) {
      setRepos(result.repos);
    }
  };

  const handleStartAuth = async () => {
    setIsLoading(true);
    setIsWaitingForAuth(true);
    setError(null);
    setDeviceCode(null);

    const result = await window.localmost.github.startDeviceFlow();

    if (result.success) {
      // Auth completed successfully
      setIsWaitingForAuth(false);

      // Check if runner is already downloaded
      const isDownloaded = await window.localmost.runner.isDownloaded();
      if (isDownloaded) {
        setStep('configure');
        loadRepos();
      } else {
        setStep('download');
      }
    } else {
      setError(result.error || 'Authentication failed');
      setIsWaitingForAuth(false);
    }

    setIsLoading(false);
  };

  const handleCancelAuth = async () => {
    await window.localmost.github.cancelAuth();
    setIsWaitingForAuth(false);
    setDeviceCode(null);
    setIsLoading(false);
  };

  const handleDownload = async () => {
    setIsLoading(true);
    setError(null);
    setDownloadProgress({ phase: 'downloading', percent: 0, message: 'Starting...' });

    const result = await window.localmost.runner.download();

    if (!result.success) {
      setError(result.error || 'Download failed');
      setIsLoading(false);
    }
    // Progress updates come via IPC
  };

  const handleConfigure = async () => {
    if (!selectedRepo) {
      setError('Please select a repository');
      return;
    }

    if (!runnerName.trim()) {
      setError('Please enter a runner name');
      return;
    }

    setIsLoading(true);
    setError(null);

    const result = await window.localmost.runner.configure({
      level: 'repo',
      repoUrl: selectedRepo,
      runnerName: runnerName.trim(),
      labels: labels.split(',').map((l) => l.trim()).filter(Boolean),
    });

    if (result.success) {
      onComplete();
    } else {
      setError(result.error || 'Configuration failed');
    }

    setIsLoading(false);
  };

  return (
    <div className={styles.setupWizard}>
      <div className={styles.setupHeader}>
        <h1>Welcome to localmost</h1>
        <p>Let's set up your local GitHub Actions runner</p>
      </div>

      <div className={styles.setupSteps}>
        <div className={step === 'auth' ? styles.stepIndicatorActive : styles.stepIndicatorDone}>
          1. Sign In
        </div>
        <div className={step === 'download' ? styles.stepIndicatorActive : step === 'configure' ? styles.stepIndicatorDone : styles.stepIndicator}>
          2. Download
        </div>
        <div className={step === 'configure' ? styles.stepIndicatorActive : styles.stepIndicator}>
          3. Configure
        </div>
      </div>

      <div className={styles.setupContent}>
        {step === 'auth' && (
          <div className={styles.setupStep}>
            <h2>Sign in with GitHub</h2>

            {!isWaitingForAuth && !deviceCode && (
              <>
                <p className={styles.stepDescription}>
                  Click below to authenticate with your GitHub account.
                  A code will appear that you'll enter on GitHub.
                </p>
                <div className={styles.authPrompt}>
                  <div className={styles.githubIcon}>
                    <svg viewBox="0 0 16 16" width="48" height="48" fill="currentColor">
                      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                    </svg>
                  </div>
                </div>
              </>
            )}

            {deviceCode && (
              <div className={styles.deviceCodeDisplay}>
                <p className={styles.stepDescription}>
                  Enter this code on GitHub to authorize localmost:
                </p>
                <div className={styles.userCode}>{deviceCode.userCode}</div>
                <p className={styles.codeHint}>
                  A browser window should have opened. If not,{' '}
                  <a href={deviceCode.verificationUri} target="_blank" rel="noopener noreferrer">
                    click here to open GitHub
                  </a>
                </p>
                <div className={shared.waitingIndicator}>
                  <div className={shared.spinner}></div>
                  <span>Waiting for authorization...</span>
                </div>
              </div>
            )}

            {isWaitingForAuth && !deviceCode && (
              <div className={shared.waitingIndicator}>
                <div className={shared.spinner}></div>
                <span>Starting authentication...</span>
              </div>
            )}
          </div>
        )}

        {step === 'download' && (
          <div className={styles.setupStep}>
            <h2>Download GitHub Actions Runner</h2>
            <p className={styles.stepDescription}>
              We'll download the official GitHub Actions runner binary.
            </p>

            {downloadProgress && (
              <div className={styles.downloadProgress}>
                <div className={styles.progressBar}>
                  <div
                    className={styles.progressFill}
                    style={{ width: `${downloadProgress.percent}%` }}
                  />
                </div>
                <p className={styles.progressMessage}>{downloadProgress.message}</p>
              </div>
            )}

            {!downloadProgress && (
              <p className={styles.hint}>This will download ~180MB from GitHub.</p>
            )}
          </div>
        )}

        {step === 'configure' && (
          <div className={styles.setupStep}>
            <h2>Configure Runner</h2>
            <p className={styles.stepDescription}>
              Choose which repository this runner should serve.
            </p>

            <div className={shared.formGroup}>
              <label>Repository</label>
              <select
                value={selectedRepo}
                onChange={(e) => setSelectedRepo(e.target.value)}
              >
                <option value="">Select a repository...</option>
                {repos.map((repo) => (
                  <option key={repo.id} value={repo.html_url}>
                    {repo.full_name}
                  </option>
                ))}
              </select>
            </div>

            <div className={shared.formGroup}>
              <label>Runner Name</label>
              <input
                type="text"
                value={runnerName}
                onChange={(e) => setRunnerName(e.target.value)}
                placeholder="my-local-runner"
              />
            </div>

            <div className={shared.formGroup}>
              <label>Labels (comma-separated)</label>
              <input
                type="text"
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                placeholder="self-hosted,macOS,ARM64"
              />
            </div>
          </div>
        )}

        {error && <div className={shared.errorMessage}>{error}</div>}

        <div className={styles.setupActions}>
          {step === 'auth' && !isWaitingForAuth && (
            <button
              className={shared.btnPrimary}
              onClick={handleStartAuth}
              disabled={isLoading}
            >
              Sign in with GitHub
            </button>
          )}

          {step === 'auth' && isWaitingForAuth && (
            <button
              className={shared.btnSecondary}
              onClick={handleCancelAuth}
            >
              Cancel
            </button>
          )}

          {step === 'download' && !downloadProgress && (
            <button
              className={shared.btnPrimary}
              onClick={handleDownload}
              disabled={isLoading}
            >
              Download Runner
            </button>
          )}

          {step === 'configure' && (
            <button
              className={shared.btnPrimary}
              onClick={handleConfigure}
              disabled={isLoading}
            >
              {isLoading ? 'Configuring...' : 'Finish Setup'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default SetupWizard;
