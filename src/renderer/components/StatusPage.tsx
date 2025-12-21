import React, { useState, useEffect, useRef } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGear, faChevronDown, faFile, faCheck, faBackwardStep, faForwardStep, faBan } from '@fortawesome/free-solid-svg-icons';
import { JobHistoryEntry, Target } from '../../shared/types';
import { GITHUB_APP_SETTINGS_URL } from '../../shared/constants';
import { useAppConfig, useRunner } from '../contexts';
import styles from './StatusPage.module.css';
import shared from '../styles/shared.module.css';

const formatTimestamp = (timestamp: string): string => {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const formatRunTime = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hours}h ${remainingMins}m`;
};

interface StatusPageProps {
  onOpenSettings: (section?: string) => void;
}

interface StatusItemProps {
  label: string;
  status: string;
  statusType: string;
  detail?: string;
  spinning?: boolean;
  link?: string;
  rightDetail?: React.ReactNode;
  onRightDetailClick?: () => void;
}

const StatusItem: React.FC<StatusItemProps> = ({ label, status, statusType, detail, spinning, link, rightDetail, onRightDetailClick }) => (
  <div className={styles.statusItem}>
    <div className={styles.statusItemHeader}>
      <span className={styles.statusItemLabel}>{label}</span>
      <div className={styles.statusItemIndicator}>
        <div
          className={spinning ? styles.statusItemDotSpinning : styles.statusItemDot}
          data-status={statusType}
        />
        <span className={styles.statusItemStatus}>{status}</span>
      </div>
    </div>
    {(detail || rightDetail) && (
      <div className={`${styles.statusItemDetail}${rightDetail ? ` ${shared.flexBetween}` : ''}`}>
        {detail ? (
          link ? (
            <a href={link} target="_blank" rel="noopener noreferrer" className={styles.detailLink}>
              {detail}
            </a>
          ) : (
            <span>{detail}</span>
          )
        ) : (
          <span />
        )}
        {rightDetail && (
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onRightDetailClick?.();
            }}
            className={styles.sleepInfoLink}
          >
            {rightDetail}
          </a>
        )}
      </div>
    )}
  </div>
);

interface RunnerStatusItemProps {
  status: string;
  statusType: string;
  runnerName: string | null;
  runnerSettingsUrl: string | null;
  runnerVersion: { version: string | null; url: string | null };
  targets: Target[];
  isConfigured: boolean;
  showUsage: boolean;
  onToggleUsage: () => void;
  onOpenRunnerConfig: () => void;
}

const RunnerStatusItem: React.FC<RunnerStatusItemProps> = ({
  status,
  statusType,
  runnerName,
  runnerSettingsUrl,
  runnerVersion,
  targets,
  isConfigured,
  showUsage,
  onToggleUsage,
  onOpenRunnerConfig,
}) => {
  // Build targets display
  const getTargetsDisplay = (): { text: string; tooltip?: string } | null => {
    if (targets.length === 0) return null;
    if (targets.length === 1) {
      const t = targets[0];
      return { text: `${t.type}: ${t.displayName}` };
    }
    // Multiple targets: show count with hover tooltip
    const tooltip = targets.map(t => `${t.type}: ${t.displayName}`).join('\n');
    return { text: `${targets.length} targets`, tooltip };
  };

  const targetsDisplay = getTargetsDisplay();

  return (
  <div className={styles.statusItemExpandable}>
    <div className={styles.statusItemHeader}>
      <span className={styles.statusItemLabel}>Runner</span>
      <div className={styles.statusItemRight}>
        <div className={styles.statusItemIndicator}>
          <div className={styles.statusItemDot} data-status={statusType} />
          <span className={styles.statusItemStatus}>{status}</span>
        </div>
        {isConfigured && (
          <button className={styles.statusItemExpand} onClick={onToggleUsage} title="How to use">
            <FontAwesomeIcon
              icon={faChevronDown}
              className={`${shared.chevronIcon} ${showUsage ? shared.chevronExpanded : shared.chevronCollapsed}`}
            />
          </button>
        )}
      </div>
    </div>
    {(runnerName || runnerVersion.version || targetsDisplay) && (
      <div className={`${styles.statusItemDetail} ${shared.flexBetween}`}>
        <span>
          {runnerName && runnerSettingsUrl ? (
            <a
              href={runnerSettingsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.runnerNameLink}
            >
              {runnerName}
            </a>
          ) : (
            runnerName
          )}
          {runnerName && runnerVersion.version && ' · '}
          {runnerVersion.version && (
            <a
              href={runnerVersion.url || '#'}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.versionLinkInline}
            >
              v{runnerVersion.version}
            </a>
          )}
        </span>
        {targetsDisplay && (
          <a
            href="#"
            className={styles.runnerTargetLink}
            onClick={(e) => {
              e.preventDefault();
              onOpenRunnerConfig();
            }}
            title={targetsDisplay.tooltip}
          >
            {targetsDisplay.text}
          </a>
        )}
      </div>
    )}
    {showUsage && (
      <div className={styles.statusItemUsage}>
        <p className={styles.usageIntro}>Add to your workflow:</p>

        <div className={styles.usageMethod}>
          <h4>Option 1: Reusable workflow</h4>
          <pre className={styles.usageCode}>
<span className={styles.codeAdd}>{`permissions:
  actions: read
  contents: read

`}</span><span className={styles.codeDim}>{'jobs:'}</span>
<span className={styles.codeAdd}>{`
  check:
    uses: bfulton/localmost/.github/workflows/check.yaml@main`}</span>
<span className={styles.codeDim}>{'\n\n  build:'}</span>
<span className={styles.codeAdd}>{'\n    needs: check\n    runs-on: ${{ needs.check.outputs.runner }}'}</span>
<span className={styles.codeDim}>{'\n    steps:\n      - uses: actions/checkout@v4\n      # ... your steps'}</span>
          </pre>
        </div>

        <div className={styles.usageMethod}>
          <h4>Option 2: Inline</h4>
          <pre className={styles.usageCode}>
<span className={styles.codeAdd}>{`permissions:
  actions: read
  contents: read

`}</span><span className={styles.codeDim}>{'jobs:'}</span>
<span className={styles.codeAdd}>{`
  check:
    runs-on: ubuntu-latest
    outputs:
      runner: \${{ steps.check.outputs.runner }}
    steps:
      - id: check
        run: |
          HEARTBEAT="\${{ vars.LOCALMOST_HEARTBEAT }}"
          if [ -n "$HEARTBEAT" ]; then
            AGE=$(($(date +%s) - $(date -d "$HEARTBEAT" +%s)))
            [ "$AGE" -lt 90 ] && echo "runner=self-hosted" >> $GITHUB_OUTPUT && exit 0
          fi
          echo "runner=macos-latest" >> $GITHUB_OUTPUT`}</span>
<span className={styles.codeDim}>{'\n\n  build:'}</span>
<span className={styles.codeAdd}>{'\n    needs: check\n    runs-on: ${{ needs.check.outputs.runner }}'}</span>
<span className={styles.codeDim}>{'\n    steps:\n      - uses: actions/checkout@v4\n      # ... your steps'}</span>
          </pre>
        </div>
      </div>
    )}
  </div>
  );
};

interface JobStatusItemProps {
  status: string;
  statusType: string;
  spinning?: boolean;
  activeJobSummary?: string;
  activeJobUrl?: string;
  jobHistory: JobHistoryEntry[];
  maxJobHistory: number;
  showHistory: boolean;
  onToggleHistory: () => void;
  sleepInfo?: React.ReactNode;
  onSleepInfoClick?: () => void;
}

const JobStatusItem: React.FC<JobStatusItemProps> = ({
  status,
  statusType,
  spinning,
  activeJobSummary,
  activeJobUrl,
  jobHistory,
  maxJobHistory,
  showHistory,
  onToggleHistory,
  sleepInfo,
  onSleepInfoClick,
}) => {
  const getStatusSymbol = (jobStatus: JobHistoryEntry['status']) => {
    switch (jobStatus) {
      case 'running': return '●';
      case 'completed': return '✓';
      case 'failed': return '✗';
      case 'cancelled': return '○';
    }
  };

  return (
    <div className={styles.statusItemExpandable}>
      <div className={styles.statusItemHeader}>
        <span className={styles.statusItemLabel}>
          Job {jobHistory.length > 0 && <span className={styles.jobCount}>({jobHistory.length >= maxJobHistory ? `>${maxJobHistory}` : jobHistory.length})</span>}
        </span>
        <div className={styles.statusItemRight}>
          <div className={styles.statusItemIndicator}>
            <div
              className={spinning ? styles.statusItemDotSpinning : styles.statusItemDot}
              data-status={statusType}
            />
            <span className={styles.statusItemStatus}>{status}</span>
          </div>
          <button className={styles.statusItemExpand} onClick={onToggleHistory} title="Job history">
            <FontAwesomeIcon
              icon={faChevronDown}
              className={`${shared.chevronIcon} ${showHistory ? shared.chevronExpanded : shared.chevronCollapsed}`}
            />
          </button>
        </div>
      </div>
      {(activeJobSummary || sleepInfo) && (
        <div className={`${styles.statusItemDetail} ${shared.flexBetween}`}>
          {activeJobSummary ? (
            activeJobUrl ? (
              <a href={activeJobUrl} target="_blank" rel="noopener noreferrer" className={styles.detailLink}>
                {activeJobSummary}
              </a>
            ) : (
              <span>{activeJobSummary}</span>
            )
          ) : (
            <span />
          )}
          {sleepInfo && (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onSleepInfoClick?.();
              }}
              className={styles.sleepInfoLink}
            >
              {sleepInfo}
            </a>
          )}
        </div>
      )}
      {showHistory && (
        <div className={styles.jobHistoryScrollable}>
          {jobHistory.length === 0 ? (
            <div className={styles.jobHistoryEmpty}>No recent jobs</div>
          ) : (
            jobHistory.map((job) => {
              // Extract instance number from runner name (e.g., "localmost.blue-243.1" -> "1")
              const instanceNum = job.runnerName?.match(/\.(\d+)$/)?.[1];
              return (
                <div key={job.id} className={styles.jobHistoryEntry}>
                  <span className={styles.jobHistoryStatus} data-status={job.status}>
                    {getStatusSymbol(job.status)}
                  </span>
                  <span className={styles.jobHistoryName}>
                    {job.actionsUrl ? (
                      <a href={job.actionsUrl} target="_blank" rel="noopener noreferrer">
                        {job.jobName}
                      </a>
                    ) : (
                      job.jobName
                    )}
                  </span>
                  {instanceNum && (
                    <span className={styles.jobHistoryRunner} title={job.runnerName}>
                      #{instanceNum}
                    </span>
                  )}
                  <span className={styles.jobHistoryTime}>
                    {formatTimestamp(job.startedAt)}
                  </span>
                  <span className={styles.jobHistoryDuration}>
                    {job.runTimeSeconds !== undefined ? formatRunTime(job.runTimeSeconds) : '...'}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};

const StatusPage: React.FC<StatusPageProps> = ({ onOpenSettings }) => {
  // Get state from contexts
  const { logs, maxLogScrollback, maxJobHistory, sleepProtection, clearLogs } = useAppConfig();
  const { user, isDownloaded, isConfigured, runnerVersion, runnerState, jobHistory, runnerConfig, runnerDisplayName, targets } = useRunner();

  // Local UI state
  const [runnerSettingsUrl, setRunnerSettingsUrl] = useState<string | null>(null);
  const [actionsUrl, setActionsUrl] = useState<string | null>(null);
  const [showUsage, setShowUsage] = useState(false);
  const [showJobHistory, setShowJobHistory] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [logPath, setLogPath] = useState<string>('');
  const [logPathCopied, setLogPathCopied] = useState(false);
  const [logFilter, setLogFilter] = useState('');
  const [, setTick] = useState(0); // Force re-render for elapsed time updates
  const logsEndRef = useRef<HTMLDivElement>(null);
  const logsContentRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true); // Track if user is scrolled to bottom
  const isProgrammaticScrollRef = useRef(false); // Ignore scroll events during programmatic scroll

  useEffect(() => {
    // Construct runner settings URL and actions URL from first target
    if (isConfigured && targets.length > 0) {
      const firstTarget = targets[0];
      const actionsQuery = '?query=is%3Ain_progress';
      if (firstTarget.type === 'org') {
        setRunnerSettingsUrl(`https://github.com/organizations/${firstTarget.owner}/settings/actions/runners`);
        setActionsUrl(`https://github.com/orgs/${firstTarget.owner}/actions${actionsQuery}`);
      } else {
        setRunnerSettingsUrl(`https://github.com/${firstTarget.owner}/${firstTarget.repo}/settings/actions/runners`);
        setActionsUrl(`https://github.com/${firstTarget.owner}/${firstTarget.repo}/actions${actionsQuery}`);
      }
    }

    // Get log file path
    window.localmost.logs.getPath().then(setLogPath);
  }, [isConfigured, targets]);

  // Helper to check if scroll is at bottom
  const isScrolledToBottom = (): boolean => {
    const container = logsContentRef.current;
    if (!container) return true; // Default to true if no container
    const { scrollTop, scrollHeight, clientHeight } = container;
    // Consider "at bottom" if within 50px of the bottom
    return scrollHeight - scrollTop - clientHeight < 50;
  };

  // Track scroll position to detect if user is at bottom
  useEffect(() => {
    const container = logsContentRef.current;
    if (!container) return;

    const handleScroll = () => {
      // Ignore scroll events during programmatic scrolling
      if (isProgrammaticScrollRef.current) return;
      isAtBottomRef.current = isScrolledToBottom();
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [logsExpanded]);

  // Helper to scroll to bottom programmatically
  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    isProgrammaticScrollRef.current = true;
    logsEndRef.current?.scrollIntoView({ behavior });
    // Reset flag after animation completes (smooth scroll takes ~300ms)
    setTimeout(() => {
      isProgrammaticScrollRef.current = false;
      isAtBottomRef.current = true;
    }, behavior === 'smooth' ? 350 : 50);
  };

  // Only auto-scroll if user was at bottom (trusting the ref for user intent)
  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom('smooth');
    }
  }, [logs]);

  // Scroll to bottom and reset ref when logs panel is expanded
  useEffect(() => {
    if (logsExpanded) {
      // Reset to bottom-tracking mode when panel opens
      isAtBottomRef.current = true;
      // Small delay to ensure the panel has rendered
      setTimeout(() => {
        scrollToBottom('instant');
      }, 50);
    }
  }, [logsExpanded]);

  // Update elapsed time for running jobs every second
  useEffect(() => {
    const hasRunningJobs = jobHistory.some(j => j.status === 'running');
    if (!hasRunningJobs) return;

    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [jobHistory]);

  // GitHub status
  const getGitHubStatus = (): { status: string; statusType: string; detail?: string; link?: string } => {
    if (!user) {
      return { status: 'Not configured', statusType: 'offline' };
    }
    return {
      status: 'Connected',
      statusType: 'running',
      detail: `@${user.login}`,
      link: GITHUB_APP_SETTINGS_URL
    };
  };

  // Runner status
  const getRunnerStatusInfo = (): { status: string; statusType: string } => {
    if (!user) {
      return { status: 'Waiting for GitHub', statusType: 'offline' };
    }
    if (!isDownloaded) {
      return { status: 'Not downloaded', statusType: 'offline' };
    }
    if (!isConfigured) {
      return { status: 'Not configured', statusType: 'offline' };
    }

    switch (runnerState.status) {
      case 'starting':
        return { status: 'Starting', statusType: 'starting' };
      case 'running':
        return { status: 'Listening', statusType: 'running' };
      case 'busy':
        return { status: 'Running job', statusType: 'busy' };
      case 'error':
        return { status: 'Error', statusType: 'error' };
      case 'idle':
        return { status: 'Idle', statusType: 'idle' };
      default:
        return { status: 'Offline', statusType: 'offline' };
    }
  };

  // Job status - summarize all running jobs
  const getJobStatus = (): { status: string; statusType: string; spinning?: boolean; activeJobSummary?: string; activeJobUrl?: string } => {
    const runningJobs = jobHistory.filter(j => j.status === 'running');

    if (runningJobs.length > 0) {
      // Find the oldest running job (latest startedAt since array is sorted newest first)
      const oldestJob = runningJobs[runningJobs.length - 1];
      const elapsedSeconds = Math.round((Date.now() - new Date(oldestJob.startedAt).getTime()) / 1000);
      const durationStr = formatRunTime(elapsedSeconds);

      let summary: string;
      if (runningJobs.length === 1) {
        summary = `1 job running for ${durationStr}`;
      } else {
        summary = `${runningJobs.length} jobs running, oldest for ${durationStr}`;
      }

      return {
        status: 'Running',
        statusType: 'busy',
        spinning: true,
        activeJobSummary: summary,
        activeJobUrl: actionsUrl || undefined
      };
    }
    return { status: 'Inactive', statusType: 'idle' };
  };

  // Sleep behavior info
  const getSleepInfo = (): React.ReactNode | undefined => {
    if (!isConfigured) return undefined;

    const isBusy = runnerState.status === 'busy';

    if (isBusy) {
      // When busy
      if (sleepProtection === 'never') {
        return <>Sleep <strong>will terminate</strong> job</>;
      } else {
        return <>Sleep <strong>blocked</strong></>;
      }
    } else {
      // When idle (not busy)
      if (sleepProtection === 'always') {
        return <>Sleep <strong>blocked</strong></>;
      } else {
        return 'Sleep allowed';
      }
    }
  };

  const githubStatus = getGitHubStatus();
  const runnerStatus = getRunnerStatusInfo();
  const jobStatus = getJobStatus();
  const sleepInfo = getSleepInfo();

  const getLogEntryClass = (level: string) => {
    switch (level) {
      case 'info': return styles.logEntryInfo;
      case 'warn': return styles.logEntryWarn;
      case 'error': return styles.logEntryError;
      case 'debug': return styles.logEntryDebug;
      default: return '';
    }
  };

  return (
    <div className={styles.statusPage}>
      <div className={shared.pageHeader}>
        <h2>Status</h2>
        <button className={shared.btnIcon} onClick={() => onOpenSettings()} title="Settings">
          <FontAwesomeIcon icon={faGear} />
        </button>
      </div>

      <div className={styles.statusContent}>
        <div className={styles.statusItems}>
        <StatusItem
          label="GitHub"
          status={githubStatus.status}
          statusType={githubStatus.statusType}
          detail={githubStatus.detail}
          link={githubStatus.link}
        />
        <RunnerStatusItem
          status={runnerStatus.status}
          statusType={runnerStatus.statusType}
          runnerName={isConfigured ? runnerDisplayName : null}
          runnerSettingsUrl={runnerSettingsUrl}
          runnerVersion={runnerVersion}
          targets={targets}
          isConfigured={isConfigured}
          showUsage={showUsage}
          onToggleUsage={() => setShowUsage(!showUsage)}
          onOpenRunnerConfig={() => onOpenSettings('runner-config-section')}
        />
        <JobStatusItem
          status={jobStatus.status}
          statusType={jobStatus.statusType}
          spinning={jobStatus.spinning}
          activeJobSummary={jobStatus.activeJobSummary}
          activeJobUrl={jobStatus.activeJobUrl}
          jobHistory={jobHistory}
          maxJobHistory={maxJobHistory}
          showHistory={showJobHistory}
          onToggleHistory={() => setShowJobHistory(!showJobHistory)}
          sleepInfo={sleepInfo}
          onSleepInfoClick={() => onOpenSettings('power-section')}
        />
      </div>

      <div className={logsExpanded ? styles.logsPanelExpanded : styles.logsPanelCollapsed}>
        <div className={styles.logsHeader} onClick={() => !logsExpanded && setLogsExpanded(true)}>
          <h3>Logs {!logsExpanded && logs.length > 0 && <span className={styles.logCount}>({logs.length >= maxLogScrollback ? `>${maxLogScrollback}` : logs.length})</span>}</h3>
          <div className={shared.flexGap4}>
            {logsExpanded && (
              <>
                {/* Copy log path */}
                <button
                  className={shared.btnIcon}
                  onClick={() => {
                    navigator.clipboard.writeText(logPath);
                    setLogPathCopied(true);
                    setTimeout(() => setLogPathCopied(false), 1500);
                  }}
                  title={logPathCopied ? 'Copied!' : `Copy log path: ${logPath}`}
                >
                  <FontAwesomeIcon
                    icon={logPathCopied ? faCheck : faFile}
                    className={logPathCopied ? shared.iconSuccess : undefined}
                  />
                </button>
                {/* Scroll to start */}
                <button
                  className={shared.btnIcon}
                  onClick={() => logsContentRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
                  title="Scroll to start"
                >
                  <FontAwesomeIcon icon={faBackwardStep} />
                </button>
                {/* Scroll to end */}
                <button
                  className={shared.btnIcon}
                  onClick={() => scrollToBottom('smooth')}
                  title="Scroll to end"
                >
                  <FontAwesomeIcon icon={faForwardStep} />
                </button>
                {/* Clear logs */}
                <button className={shared.btnIcon} onClick={clearLogs} title="Clear logs">
                  <FontAwesomeIcon icon={faBan} />
                </button>
              </>
            )}
            {/* Expand/Collapse chevron */}
            <button
              className={shared.btnIcon}
              onClick={() => setLogsExpanded(!logsExpanded)}
              title={logsExpanded ? 'Collapse logs' : 'Expand logs'}
            >
              <FontAwesomeIcon
                icon={faChevronDown}
                className={`${shared.chevronIcon} ${logsExpanded ? shared.chevronExpanded : shared.chevronCollapsed}`}
              />
            </button>
          </div>
        </div>
        {logsExpanded && (
          <>
            <div className={styles.logsFilter}>
              <input
                type="text"
                placeholder="Filter logs..."
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                className={styles.logsFilterInput}
              />
              {logFilter && (
                <button
                  className={styles.logsFilterClear}
                  onClick={() => setLogFilter('')}
                  title="Clear filter"
                >
                  ×
                </button>
              )}
            </div>
            <div className={styles.logsContent} ref={logsContentRef}>
              {logs.length === 0 ? (
                <div className={styles.logsEmpty}>No logs yet</div>
              ) : (
                (() => {
                  const filteredLogs = logFilter
                    ? logs.filter(log =>
                        log.message.toLowerCase().includes(logFilter.toLowerCase()) ||
                        log.level.toLowerCase().includes(logFilter.toLowerCase())
                      )
                    : logs;
                  return filteredLogs.length === 0 ? (
                    <div className={styles.logsEmpty}>No matching logs</div>
                  ) : (
                    filteredLogs.map((log, i) => (
                      <div key={i} className={`${styles.logEntry} ${getLogEntryClass(log.level)}`}>
                        <span className={styles.logTimestamp}>
                          {formatTimestamp(log.timestamp)}
                        </span>
                        <span className={styles.logLevel}>[{log.level.toUpperCase()}]</span>
                        <span className={styles.logMessage}>{log.message}</span>
                      </div>
                    ))
                  );
                })()
              )}
              <div ref={logsEndRef} />
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  );
};

export default StatusPage;
