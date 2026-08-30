import { ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as yaml from 'js-yaml';
import {
  SandboxPolicyLevel, RunnerState, RunnerStatus, LogEntry, RunnerConfig, JobHistoryEntry, JobStatus, LOG_LEVEL_PRIORITY, LogLevel, UserFilterConfig, SANDBOX_POLICY_LEVEL_DESCRIPTIONS } from '../shared/types';
import { DEFAULT_RUNNER_COUNT, DEFAULT_MAX_JOB_HISTORY, MIN_RUNNER_COUNT, MAX_RUNNER_COUNT } from '../shared/constants';
import { spawnSandboxed } from './process-sandbox';
import { ProxyServer, ProxyLogEntry } from './proxy-server';
import { RunnerDownloader } from './runner-downloader';
import { getConfigPath, getJobHistoryPath, getRunnerDir } from './paths';
import { loadConfig } from './config';
import { normalizeFilterConfig, isUserAllowed, areAllUsersAllowed, parseRepository } from './runner/user-filter';

/**
 * Get the hostname without .local suffix (common on macOS).
 */
function getCleanHostname(): string {
  return os.hostname().replace(/\.local$/, '');
}

interface RunnerInstance {
  process: ChildProcess | null;
  status: RunnerStatus;
  currentJob: {
    name: string;
    repository: string;
    startedAt: string;
    id: string;
    targetId?: string;        // For multi-target: which target this job came from
    targetDisplayName?: string;
    actionsUrl?: string;      // GitHub Actions URL for this job
    githubRunId?: number;     // GitHub workflow run ID (for cancellation)
    githubJobId?: number;     // GitHub job ID (for querying conclusion)
    githubActor?: string;     // Username who triggered the workflow
    githubSha?: string;       // Commit SHA that triggered the workflow
    githubRef?: string;       // Branch/tag ref (e.g., refs/heads/main)
  } | null;
  name: string;
  jobsCompleted: number;
  fatalError: boolean; // Set when runner has an unrecoverable error (e.g., registration deleted)
}

/** Job event types for notifications */
export type JobEventType = 'started' | 'completed' | 'refused';

/** Job event data for notifications */
export interface JobEvent {
  type: JobEventType;
  jobName: string;
  repository: string;
  status?: 'completed' | 'failed' | 'cancelled';
  /** Why a refused job was not run */
  reason?: string;
}

/** What a repository's approved policy means for one job at runtime. */
export interface RepoPolicyRuntime {
  /** Hosts the policy declares, on top of runner infrastructure. */
  hosts: string[];
  /** The level the policy asks for; strict when it declares none. */
  level: SandboxPolicyLevel;
}

interface RunnerManagerOptions {
  onLog: (entry: LogEntry) => void;
  onStatusChange: (state: RunnerState) => void;
  onJobHistoryUpdate: (jobs: JobHistoryEntry[]) => void;
  onReregistrationNeeded?: (instanceNum: number, reason: 'session_conflict' | 'registration_deleted') => Promise<void>;
  /** Called when an instance needs to be configured on-demand (lazy configuration) */
  onConfigurationNeeded?: (instanceNum: number) => Promise<void>;
  getRunnerLogLevel?: () => LogEntry['level'];
  /** Get user filter configuration */
  getUserFilter?: () => UserFilterConfig | undefined;
  /** Get the current authenticated user login */
  getCurrentUserLogin?: () => string | undefined;
  /** Cancel a workflow run */
  cancelWorkflowRun?: (owner: string, repo: string, runId: number) => Promise<void>;
  /** Get job conclusion from GitHub API */
  getJobConclusion?: (owner: string, repo: string, jobId: number) => Promise<string | null>;
  /** Get all contributors/authors for a repo at a given commit SHA (for contributor filtering) */
  getAllContributors?: (owner: string, repo: string, sha: string) => Promise<Set<string>>;
  /** The repository and commit a job belongs to, from the broker. */
  getJobTarget?: (jobId: string) => { targetDisplayName: string; githubSha?: string } | undefined;
  /** The repository's approved policy, resolved for the job about to run. */
  getRepoPolicy?: (owner: string, repo: string, sha: string, workflowName: string) => Promise<RepoPolicyRuntime>;
  /** Called when a job starts or completes (for notifications) */
  onJobEvent?: (event: JobEvent) => void;
}

export class RunnerManager {
  private instances: Map<number, RunnerInstance> = new Map();
  private runnerCount = DEFAULT_RUNNER_COUNT;
  private startedAt: string | null = null;
  private config: RunnerConfig | null = null;
  private baseRunnerName: string | null = null;
  private onLog: (entry: LogEntry) => void;
  private onStatusChange: (state: RunnerState) => void;
  private onJobHistoryUpdate: (jobs: JobHistoryEntry[]) => void;
  private onReregistrationNeeded?: (instanceNum: number, reason: 'session_conflict' | 'registration_deleted') => Promise<void>;
  private onConfigurationNeeded?: (instanceNum: number) => Promise<void>;
  private getRunnerLogLevel: () => LogEntry['level'];
  private getUserFilter?: () => UserFilterConfig | undefined;
  private getCurrentUserLogin?: () => string | undefined;
  private cancelWorkflowRun?: (owner: string, repo: string, runId: number) => Promise<void>;
  private getJobConclusion?: (owner: string, repo: string, jobId: number) => Promise<string | null>;
  private getAllContributors?: (owner: string, repo: string, sha: string) => Promise<Set<string>>;
  private getRepoPolicy?: (owner: string, repo: string, sha: string, workflowName: string) => Promise<RepoPolicyRuntime>;
  private getJobTarget?: (jobId: string) => { targetDisplayName: string; githubSha?: string } | undefined;
  private onJobEvent?: (event: JobEvent) => void;
  private jobHistory: JobHistoryEntry[] = [];
  private jobIdCounter = 0;
  private maxJobHistory = DEFAULT_MAX_JOB_HISTORY;

  // Proxy servers for network isolation and logging (one per instance)
  private proxyServers: Map<number, ProxyServer> = new Map();

  // Flag to track intentional stops vs job completion restarts
  private stopping = false;

  // Runner downloader for directory management
  private readonly downloader: RunnerDownloader;

  // Config path for localmost settings
  private readonly configPath: string;

  // Current runner version
  private runnerVersion: string | null = null;

  // Preserve work directory setting: 'never' | 'session' | 'always'
  private preserveWorkDir: 'never' | 'session' | 'always' = 'never';

  // Tool cache location: 'persistent' (shared) or 'per-sandbox' (rebuilt each time)
  private toolCacheLocation: 'persistent' | 'per-sandbox' = 'persistent';

  // Track instances currently being started/rebuilt to prevent concurrent operations
  /** How long to wait for a worker slot before giving up on an acquired job. */
  private static readonly SLOT_WAIT_MS = 60_000;

  private startingInstances: Set<number> = new Set();
  /**
   * Slots claimed for a job that has been acquired from GitHub but whose worker
   * has not started yet. Separate from startingInstances, which startInstance
   * uses as its own re-entry guard.
   */
  private reservedSlots: Set<number> = new Set();

  // Path to job history file
  private readonly jobHistoryPath: string;

  // Pending target context for jobs received from broker
  // Maps runner name (or 'next') to target context
  private pendingTargetContext: Map<string, { targetId: string; targetDisplayName: string; actionsUrl?: string; githubRunId?: number; githubJobId?: number; githubActor?: string; githubSha?: string; githubRef?: string }> = new Map();

  /**
   * Validate that a child path stays within the expected base directory.
   * Prevents path traversal attacks via malicious directory names.
   * @returns The validated path, or null if it escapes the base.
   */
  private validateChildPath(base: string, childName: string): string | null {
    // Reject names with path separators or traversal sequences
    if (childName.includes('/') || childName.includes('\\') || childName.includes('..')) {
      return null;
    }
    const childPath = path.join(base, childName);
    const normalizedChild = path.normalize(childPath);
    const normalizedBase = path.normalize(base);
    // Ensure the resolved path is within the base directory
    if (!normalizedChild.startsWith(normalizedBase + path.sep) && normalizedChild !== normalizedBase) {
      return null;
    }
    return normalizedChild;
  }

  constructor(options: RunnerManagerOptions) {
    this.onLog = options.onLog;
    this.onStatusChange = options.onStatusChange;
    this.onJobHistoryUpdate = options.onJobHistoryUpdate;
    this.onReregistrationNeeded = options.onReregistrationNeeded;
    this.onConfigurationNeeded = options.onConfigurationNeeded;
    this.getRunnerLogLevel = options.getRunnerLogLevel ?? (() => 'warn');
    this.getUserFilter = options.getUserFilter;
    this.getCurrentUserLogin = options.getCurrentUserLogin;
    this.cancelWorkflowRun = options.cancelWorkflowRun;
    this.getJobConclusion = options.getJobConclusion;
    this.getAllContributors = options.getAllContributors;
    this.getRepoPolicy = options.getRepoPolicy;
    this.getJobTarget = options.getJobTarget;
    this.onJobEvent = options.onJobEvent;

    this.downloader = new RunnerDownloader();
    this.configPath = getConfigPath();
    this.jobHistoryPath = getJobHistoryPath();

    // Load runner config
    this.loadRunnerConfig();

    // Load persisted job history
    this.loadJobHistory();
  }

  /**
   * Load job history from disk.
   */
  private loadJobHistory(): void {
    try {
      if (fs.existsSync(this.jobHistoryPath)) {
        const content = fs.readFileSync(this.jobHistoryPath, 'utf-8');
        const data = JSON.parse(content);
        if (Array.isArray(data.jobs)) {
          this.jobHistory = data.jobs.slice(-this.maxJobHistory);

          // Clean up stale "running" jobs from previous sessions
          let staleCount = 0;
          for (const job of this.jobHistory) {
            if (job.status === 'running') {
              job.status = 'cancelled';
              job.completedAt = new Date().toISOString();
              staleCount++;
            }
          }
          if (staleCount > 0) {
            this.log('info', `Marked ${staleCount} stale running job(s) as cancelled`);
            this.saveJobHistory();
          }

          // Get the highest job ID to continue the counter
          for (const job of this.jobHistory) {
            const match = job.id.match(/job-(\d+)/);
            if (match) {
              const id = parseInt(match[1], 10);
              if (id > this.jobIdCounter) {
                this.jobIdCounter = id;
              }
            }
          }
          this.log('info', `Loaded ${this.jobHistory.length} jobs from history`);
        }
      }
    } catch (err) {
      this.log('warn', `Failed to load job history: ${(err as Error).message}`);
    }
  }

  /**
   * Save job history to disk.
   */
  private saveJobHistory(): void {
    try {
      const data = {
        version: 1,
        savedAt: new Date().toISOString(),
        jobs: this.jobHistory,
      };
      fs.writeFileSync(this.jobHistoryPath, JSON.stringify(data, null, 2));
    } catch (err) {
      this.log('warn', `Failed to save job history: ${(err as Error).message}`);
    }
  }

  /**
   * Kill a process and all its children by killing the process group.
   * Uses negative PID to kill the entire process group.
   */
  private killProcessGroup(proc: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (!proc.pid) return false;

    try {
      // Kill the entire process group using negative PID
      process.kill(-proc.pid, signal);
      this.log('debug', `Sent ${signal} to process group -${proc.pid}`);
      return true;
    } catch (err) {
      // Process group might not exist, fall back to regular kill
      this.log('debug', `Process group kill failed, trying regular kill: ${(err as Error).message}`);
    }

    try {
      proc.kill(signal);
      return true;
    } catch {
      // Process already dead or permission denied - either way, nothing more to do
      return false;
    }
  }


  setRunnerCount(count: number): void {
    this.runnerCount = Math.max(MIN_RUNNER_COUNT, Math.min(MAX_RUNNER_COUNT, count));
  }

  getRunnerCount(): number {
    return this.runnerCount;
  }

  setMaxJobHistory(max: number): void {
    this.maxJobHistory = Math.max(5, Math.min(50, max));
    if (this.jobHistory.length > this.maxJobHistory) {
      this.jobHistory = this.jobHistory.slice(-this.maxJobHistory);
      this.onJobHistoryUpdate(this.jobHistory);
    }
  }

  /**
   * Set pending target context for the next job received by a runner.
   * Called by broker-proxy-service when a job is received from a target.
   * @param runnerName The runner name or 'next' to apply to next job on any runner
   * @param targetId The target ID from which the job was received
   * @param targetDisplayName Human-readable target name
   * @param actionsUrl The GitHub Actions URL for this job
   * @param githubRunId The GitHub workflow run ID (for cancellation)
   * @param githubJobId The GitHub job ID (for querying conclusion)
   * @param githubActor The username who triggered the workflow (for user filtering)
   * @param githubSha The commit SHA that triggered the workflow
   * @param githubRef The branch/tag ref (e.g., refs/heads/main)
   */
  setPendingTargetContext(runnerName: string, targetId: string, targetDisplayName: string, actionsUrl?: string, githubRunId?: number, githubJobId?: number, githubActor?: string, githubSha?: string, githubRef?: string): void {
    this.pendingTargetContext.set(runnerName, { targetId, targetDisplayName, actionsUrl, githubRunId, githubJobId, githubActor, githubSha, githubRef });
    this.log('debug', `Set pending target context for ${runnerName}: ${targetDisplayName} (runId=${githubRunId}, jobId=${githubJobId}, actor=${githubActor}, sha=${githubSha?.slice(0, 7)})`);
  }

  /**
   * Consume pending target context for a runner.
   * Returns and removes the context if found.
   */
  private consumePendingTargetContext(runnerName: string): { targetId: string; targetDisplayName: string; actionsUrl?: string; githubRunId?: number; githubJobId?: number; githubActor?: string; githubSha?: string; githubRef?: string } | undefined {
    // Try exact match first, then fall back to 'next'
    let context = this.pendingTargetContext.get(runnerName);
    if (context) {
      this.pendingTargetContext.delete(runnerName);
      return context;
    }
    context = this.pendingTargetContext.get('next');
    if (context) {
      this.pendingTargetContext.delete('next');
      return context;
    }
    return undefined;
  }

  private loadRunnerConfig(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const yamlContent = fs.readFileSync(this.configPath, 'utf-8');
        const config = yaml.load(yamlContent, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown> | null;
        if (config?.runnerConfig) {
          const runnerConfig = config.runnerConfig as Record<string, unknown>;
          if (runnerConfig.runnerName) {
            this.baseRunnerName = runnerConfig.runnerName as string;
            this.log('info', `Loaded runner name from settings: ${this.baseRunnerName}`);
          }
          if (runnerConfig.runnerCount) {
            this.runnerCount = runnerConfig.runnerCount as number;
            this.log('info', `Loaded runner count: ${this.runnerCount}`);
          }
          // Load repo/org URL for job links
          let url: string | undefined;
          if (runnerConfig.repoUrl) {
            url = runnerConfig.repoUrl as string;
          } else if (runnerConfig.orgName) {
            url = `https://github.com/${runnerConfig.orgName}`;
          }
          if (url) {
            this.config = {
              url,
              token: '',
              name: this.baseRunnerName || '',
              labels: [],
              workFolder: '_work',
            };
          }
        }
        if (config && config.maxJobHistory) {
          this.maxJobHistory = Math.max(5, Math.min(50, config.maxJobHistory as number));
        }
        if (config && typeof config.preserveWorkDir === 'string' &&
            ['never', 'session', 'always'].includes(config.preserveWorkDir)) {
          this.preserveWorkDir = config.preserveWorkDir as 'never' | 'session' | 'always';
        }
        if (config && typeof config.toolCacheLocation === 'string' &&
            ['persistent', 'per-sandbox'].includes(config.toolCacheLocation)) {
          this.toolCacheLocation = config.toolCacheLocation as 'persistent' | 'per-sandbox';
        }
      }

      // Fall back to config directory's .runner file for name
      if (!this.baseRunnerName) {
        const configDir = this.downloader.getConfigDir(1);
        const runnerConfigPath = path.join(configDir, '.runner');
        if (fs.existsSync(runnerConfigPath)) {
          const content = fs.readFileSync(runnerConfigPath, 'utf-8').replace(/^\ufeff/, '');
          const runnerConfig = JSON.parse(content);
          if (runnerConfig.agentName) {
            const name = runnerConfig.agentName;
            this.baseRunnerName = name.replace(/\.\d+$/, '');
            this.log('info', `Loaded runner name from config: ${this.baseRunnerName}`);
          }
        }
      }

      // Fall back to hostname-based name
      if (!this.baseRunnerName) {
        this.baseRunnerName = `localmost.${getCleanHostname()}`;
      }
    } catch (error) {
      this.log('error', `Error loading runner config: ${error}`);
      this.baseRunnerName = `localmost.${getCleanHostname()}`;
    }
  }

  private getInstanceName(instance: number): string {
    // Always use .N suffix to match how runners are registered with GitHub
    // (registration always uses baseRunnerName.N format)
    return `${this.baseRunnerName || `localmost.${getCleanHostname()}`}.${instance}`;
  }

  getJobHistory(): JobHistoryEntry[] {
    return this.jobHistory;
  }

  getStatus(): RunnerState {
    // If shutting down, return that status
    if (this.stopping) {
      return {
        status: 'shutting_down',
        startedAt: this.startedAt ?? undefined,
      };
    }

    // If no instances exist or we're not started, return offline
    if (this.instances.size === 0 || !this.startedAt) {
      return {
        status: 'offline',
        startedAt: undefined,
      };
    }

    // Priority: busy > listening > starting > error > offline
    let aggregateStatus: RunnerStatus = 'offline';
    let currentJob: { name: string; repository: string; runnerName: string } | null = null;

    for (const [, instance] of this.instances) {
      if (instance.status === 'busy') {
        aggregateStatus = 'busy';
        if (instance.currentJob) {
          currentJob = {
            name: instance.currentJob.name,
            repository: instance.currentJob.repository,
            runnerName: instance.name,
          };
        }
        break;
      } else if (instance.status === 'listening') {
        aggregateStatus = 'listening';
      } else if (instance.status === 'starting' && aggregateStatus !== 'listening') {
        aggregateStatus = 'starting';
      } else if (instance.status === 'error' && aggregateStatus !== 'listening' && aggregateStatus !== 'starting') {
        aggregateStatus = 'error';
      }
    }

    return {
      status: aggregateStatus,
      jobName: currentJob?.name,
      repository: currentJob?.repository,
      startedAt: this.startedAt ?? undefined,
    };
  }

  getStatusDisplayName(): string {
    // Use target-based naming for multi-target mode
    const config = loadConfig();
    const targets = config.targets || [];

    if (targets.length === 1) {
      // Single target: show the proxy runner name
      return targets[0].proxyRunnerName;
    } else if (targets.length > 1) {
      // Multiple targets: show prefix with wildcard
      return `localmost.${getCleanHostname()}.*`;
    }

    // Fallback for legacy single-runner mode (no targets)
    const baseName = this.baseRunnerName || `localmost.${getCleanHostname()}`;
    if (this.runnerCount === 1) {
      return `${baseName}.1`;
    }
    return `${baseName}.1-${this.runnerCount}`;
  }

  isRunning(): boolean {
    for (const [, instance] of this.instances) {
      // Consider running if process is active OR status indicates active state
      if (instance.process || instance.status === 'starting' || instance.status === 'listening' || instance.status === 'busy') {
        return true;
      }
    }
    return false;
  }

  isConfigured(): boolean {
    // In proxy-only mode, check for proxy credentials instead of individual worker configs
    return this.downloader.hasAnyProxyCredentials();
  }

  getPreserveWorkDir(): 'never' | 'session' | 'always' {
    return this.preserveWorkDir;
  }

  getToolCacheLocation(): 'persistent' | 'per-sandbox' {
    return this.toolCacheLocation;
  }

  async start(): Promise<void> {
    if (this.isRunning()) {
      this.log('warn', 'Runner is already running');
      return;
    }

    // Show 'starting' status immediately while we do setup
    this.startedAt = new Date().toISOString();
    this.updateStatus('starting');

    if (!this.downloader.isDownloaded()) {
      this.startedAt = null;
      this.updateStatus('offline');
      throw new Error('Runner is not downloaded. Please download first.');
    }

    if (!this.isConfigured()) {
      this.startedAt = null;
      this.updateStatus('offline');
      throw new Error('Runner is not configured. Please complete setup first.');
    }

    this.loadRunnerConfig();

    // Get the installed version
    this.runnerVersion = this.downloader.getInstalledVersion();
    if (!this.runnerVersion) {
      this.startedAt = null;
      this.updateStatus('offline');
      throw new Error('Could not determine runner version.');
    }

    // Kill any stale runner processes
    await this.killStaleProcesses();
    await this.detectStaleRunnerProcesses();

    const displayName = this.getStatusDisplayName();
    this.log('info', `Starting runner pool (max ${this.runnerCount}, ${displayName})...`);

    this.instances.clear();
    this.startingInstances.clear();
    this.stopping = false;

    // Start with just 1 runner - will scale up dynamically
    await this.startInstance(1);

    this.updateStatus('listening');
  }

  /**
   * Initialize the runner manager without starting any workers.
   * Used for on-demand worker spawning where broker proxy triggers worker starts.
   */
  async initialize(): Promise<void> {
    this.startedAt = new Date().toISOString();
    this.updateStatus('starting');

    if (!this.isConfigured()) {
      this.startedAt = null;
      this.updateStatus('offline');
      throw new Error('Runner is not configured. Please complete setup first.');
    }

    this.loadRunnerConfig();

    // Get the installed version
    this.runnerVersion = this.downloader.getInstalledVersion();
    if (!this.runnerVersion) {
      this.startedAt = null;
      this.updateStatus('offline');
      throw new Error('Could not determine runner version.');
    }

    // Kill any stale runner processes
    await this.killStaleProcesses();
    await this.detectStaleRunnerProcesses();

    const displayName = this.getStatusDisplayName();
    this.log('info', `Runner manager initialized (max ${this.runnerCount}, ${displayName})`);

    this.instances.clear();
    this.startingInstances.clear();
    this.stopping = false;

    // Don't start any instances - workers will be spawned on demand
    this.updateStatus('listening');
  }

  /**
   * Check if there's an available slot for a new worker.
   * Used by broker proxy to decide whether to acquire a job.
   */
  hasAvailableSlot(): boolean {
    for (let i = 1; i <= this.runnerCount; i++) {
      const instance = this.instances.get(i);
      if (!instance || instance.status === 'offline' || instance.status === 'error') {
        return true;
      }
    }
    return false;
  }

  /**
   * Spawn a worker to handle a job received by the broker proxy.
   * Finds an available instance slot and starts a worker there.
   */
  /**
   * Claim a worker slot, synchronously, for a job that is about to start.
   *
   * The claim has to happen in one step. The broker checks capacity, then
   * acquires the job from GitHub - a network round trip - before a worker
   * exists, so two jobs arriving together would otherwise pick the same slot
   * and one of them would be acquired upstream and never run.
   */
  private reserveSlot(): number | null {
    for (let i = 1; i <= this.runnerCount; i++) {
      if (this.reservedSlots.has(i) || this.startingInstances.has(i)) continue;
      const instance = this.instances.get(i);
      if (!instance || instance.status === 'offline' || instance.status === 'error') {
        this.reservedSlots.add(i);
        return i;
      }
    }
    return null;
  }

  private releaseSlotReservation(instanceNum: number): void {
    this.reservedSlots.delete(instanceNum);
  }

  async spawnWorkerForJob(): Promise<void> {
    // Take the context before waiting for a slot. 'next' is a single shared
    // slot, so a job arriving during the wait would otherwise overwrite it and
    // this worker would start with another repository's context.
    const claimedContext = this.pendingTargetContext.get('next');
    if (claimedContext) {
      this.pendingTargetContext.delete('next');
    }

    // Wait briefly for a slot rather than dropping the job. By this point the
    // broker has already acquired it from GitHub, so returning without running
    // it leaves GitHub waiting on a runner that never reports - the job then
    // fails after its timeout with no steps recorded.
    let instanceNum = this.reserveSlot();
    const waitUntil = Date.now() + RunnerManager.SLOT_WAIT_MS;
    while (instanceNum === null && Date.now() < waitUntil) {
      await new Promise(resolve => setTimeout(resolve, 500));
      instanceNum = this.reserveSlot();
    }

    if (instanceNum === null) {
      // Put it back: this worker never started, so the context still describes
      // a job that something else may yet pick up.
      if (claimedContext) {
        this.pendingTargetContext.set('next', claimedContext);
      }
      this.log('error', 'No worker slot became available; this job will not run');
      return;
    }

    // Get the target context for this job (claimed above, before the wait)
    const targetContext = claimedContext;
    if (!targetContext) {
      this.log('error', 'No target context for spawned worker');
      this.releaseSlotReservation(instanceNum);
      return;
    }

    this.log('info', `Spawning worker ${instanceNum} for incoming job from ${targetContext.targetDisplayName}...`);

    // Keyed by instance so startInstance can install the policy for this job
    // before the runner starts; 'next' is consumed by whichever worker registers.
    this.pendingTargetContext.set(String(instanceNum), targetContext);

    // Copy proxy credentials to this instance's config before building sandbox
    const proxyDir = path.join(getRunnerDir(), 'proxies', targetContext.targetId);
    if (fs.existsSync(proxyDir)) {
      try {
        await this.downloader.copyProxyCredentials(
          instanceNum,
          proxyDir,
          (level, msg) => this.log(level, msg)
        );
      } catch (err) {
        this.log('error', `Failed to copy proxy credentials: ${(err as Error).message}`);
        this.releaseSlotReservation(instanceNum);
        return;
      }
    } else {
      this.log('error', `Proxy credentials not found for target ${targetContext.targetId}`);
      this.releaseSlotReservation(instanceNum);
      return;
    }

    // Configure and start the instance
    // The instance will connect to broker proxy and pick up the queued job
    try {
      await this.startInstance(instanceNum);
    } finally {
      // startInstance has taken over the slot (or failed); either way the
      // reservation has served its purpose.
      this.releaseSlotReservation(instanceNum);
    }
  }

  private async startInstanceProxy(instanceNum: number): Promise<ProxyServer> {
    const proxy = new ProxyServer({
      // Closed until a job is claimed. The level belongs to the repository's
      // policy now, and is installed when a worker announces which job it took.
      policyLevel: 'strict',
      onJobAcquired: async (jobId: string) => {
        // The worker behind this proxy just claimed a job. Whichever instance
        // won the queue, this is the one that has to carry its policy.
        const target = this.getJobTarget?.(jobId);
        if (!target?.targetDisplayName || !target.githubSha) {
          // Saying the policy is closed is not the same as closing it. This
          // proxy may still hold the last job's hosts, so clear them: an
          // unidentifiable job gets nothing rather than someone else's grants.
          const staleProxy = this.proxyServers.get(instanceNum);
          staleProxy?.setPolicyAllowedHosts([]);
          staleProxy?.setPolicyLevel('strict');
          this.log('warn', `[instance ${instanceNum}] No target for acquired job ${jobId}; policy closed`);
          return;
        }
        await this.applyPolicyForTarget(
          instanceNum,
          target.targetDisplayName,
          target.githubSha,
          ''
        );
      },
      onLog: (entry: ProxyLogEntry) => {
        // Skip logging routine localhost message polling (very noisy)
        if (!entry.blocked && (entry.host === 'localhost' || entry.host === '127.0.0.1')) {
          return;
        }
        const status = entry.blocked ? 'BLOCKED' : 'ALLOWED';
        const reasonSuffix = entry.reason ? ` (${entry.reason})` : '';
        this.log('info', `[proxy ${instanceNum}] ${status} ${entry.method} ${entry.host}:${entry.port}${entry.path || ''}${reasonSuffix}`);
      },
    });

    const port = await proxy.start();
    this.log('debug', `Proxy server for instance ${instanceNum} started on port ${port}; policy installed when a job is claimed`);
    this.proxyServers.set(instanceNum, proxy);
    return proxy;
  }

  private async stopInstanceProxy(instanceNum: number): Promise<void> {
    const proxy = this.proxyServers.get(instanceNum);
    if (proxy) {
      try {
        await proxy.stop();
      } catch {
        // Proxy stop failed - non-fatal, may already be stopped
      }
      this.proxyServers.delete(instanceNum);
    }
  }

  /**
   * Start a single runner instance. Used for initial start and re-registration.
   */
  async startInstance(instanceNum: number): Promise<void> {
    // Prevent concurrent sandbox builds for the same instance
    if (this.startingInstances.has(instanceNum)) {
      this.log('debug', `Instance ${instanceNum} is already starting, skipping duplicate start`);
      return;
    }

    if (!this.runnerVersion) {
      this.log('error', `Cannot start instance ${instanceNum}: no runner version`);
      return;
    }

    this.startingInstances.add(instanceNum);
    const instanceName = this.getInstanceName(instanceNum);

    // Set 'starting' status immediately so UI shows it during sandbox build
    const existingInstance = this.instances.get(instanceNum);
    const instance: RunnerInstance = {
      process: null,
      status: 'starting',
      currentJob: null,
      name: instanceName,
      jobsCompleted: existingInstance?.jobsCompleted ?? 0,
      fatalError: false,
    };
    this.instances.set(instanceNum, instance);
    this.updateAggregateStatus();

    // Build fresh sandbox from arc + config
    this.log('info', `Building sandbox for instance ${instanceNum}...`);
    let sandboxDir: string;
    try {
      sandboxDir = await this.downloader.buildSandbox(
        instanceNum,
        this.runnerVersion,
        (level, msg) => {
          this.log(level, `[sandbox ${instanceNum}] ${msg}`);
        },
        { preserveWorkDir: this.preserveWorkDir !== 'never' }
      );
    } catch (error) {
      this.log('error', `Failed to build sandbox for instance ${instanceNum}: ${(error as Error).message}`);
      instance.status = 'error';
      this.updateAggregateStatus();
      this.startingInstances.delete(instanceNum);
      return;
    }

    const runnerBinary = path.join(sandboxDir, 'run.sh');

    if (!fs.existsSync(runnerBinary)) {
      this.log('warn', `Runner binary not found for instance ${instanceNum}, skipping`);
      instance.status = 'error';
      this.updateAggregateStatus();
      this.startingInstances.delete(instanceNum);
      return;
    }

    // Verify config is in sandbox
    const runnerConfigFile = path.join(sandboxDir, '.runner');
    if (!fs.existsSync(runnerConfigFile)) {
      this.log('warn', `Runner instance ${instanceNum} not configured, skipping`);
      instance.status = 'error';
      this.updateAggregateStatus();
      this.startingInstances.delete(instanceNum);
      return;
    }

    try {
      // Start proxy for this instance (or reuse existing)
      let proxy = this.proxyServers.get(instanceNum);
      if (!proxy) {
        proxy = await this.startInstanceProxy(instanceNum);
      }

      // Install the policy before the runner process exists. A reused proxy
      // still holds the last job's hosts until this runs.
      proxy.setPolicyAllowedHosts([]);
      proxy.setPolicyLevel('strict');
      const startupContext = this.pendingTargetContext.get(String(instanceNum));
      if (startupContext?.targetDisplayName && startupContext.githubSha) {
        await this.applyPolicyForTarget(
          instanceNum,
          startupContext.targetDisplayName,
          startupContext.githubSha,
          ''
        );
      }

      const proxyUrl = proxy.getProxyUrl();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT: 'true',
      };

      // Set tool cache location based on setting
      // 'persistent' = shared directory that survives restarts (fast subsequent jobs)
      // 'per-sandbox' = inside sandbox, rebuilt each time (clean but slow)
      if (this.toolCacheLocation === 'persistent') {
        const toolCacheDir = this.downloader.getToolCacheDir();
        env.RUNNER_TOOL_CACHE = toolCacheDir;
        env.AGENT_TOOLSDIRECTORY = toolCacheDir; // Some actions check this instead
      }

      env.http_proxy = proxyUrl;
      env.https_proxy = proxyUrl;
      env.HTTP_PROXY = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;

      instance.process = spawnSandboxed(runnerBinary, ['--once'], {
        cwd: sandboxDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Create a new process group so we can kill all child processes
        detached: true,
        proxyPort: proxy.getPort(),
      });

      // Don't set 'running' until we see "Listening for Jobs"
      // instance.status stays 'offline' until confirmed

      // Write PID file for orphan detection
      if (instance.process.pid) {
        const pidFile = path.join(sandboxDir, 'runner.pid');
        fs.writeFileSync(pidFile, instance.process.pid.toString());
      }

      instance.process.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        lines.forEach((line) => {
          this.parseRunnerOutput(instanceNum, line);
          this.logInstanceOutput(instanceNum, 'debug', line);
        });
      });

      instance.process.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        lines.forEach((line) => {
          this.parseRunnerOutput(instanceNum, line); // Also parse stderr for status
          this.logInstanceOutput(instanceNum, 'error', line);
        });
      });

      instance.process.on('error', (error) => {
        this.log('error', `Runner instance ${instanceNum} error: ${error.message}`);
        instance.status = 'error';
        this.updateStatus('error', error.message);
      });

      instance.process.on('exit', (code, signal) => {
        instance.process = null;
        instance.currentJob = null;

        // Intentional stop - don't restart
        if (signal === 'SIGTERM' || signal === 'SIGINT' || this.stopping) {
          this.log('info', `Runner instance ${instanceNum} stopped`);
          instance.status = 'offline';

          if (!this.isRunning()) {
            this.startedAt = null;
            this.updateStatus('offline');
          }
          return;
        }

        // Error exit - don't restart
        if (code !== 0 || code === null) {
          const exitInfo = signal ? `signal ${signal}` : `code ${code}`;
          this.log('error', `Runner instance ${instanceNum} exited with ${exitInfo}`);
          instance.status = 'error';
          this.updateAggregateStatus();
          return;
        }

        // Clean exit - job completed (unless there was a fatal error)
        if (instance.fatalError) {
          this.log('error', `Runner instance ${instanceNum} has fatal error, not recycling`);
          instance.status = 'error';
          this.updateAggregateStatus();
          return;
        }

        instance.jobsCompleted++;
        this.log('info', `Runner instance ${instanceNum} completed job #${instance.jobsCompleted}`);
        this.releaseInstanceSlot(instanceNum);
      });

      this.instances.set(instanceNum, instance);
      // Successfully started - clear the starting flag
      this.startingInstances.delete(instanceNum);
    } catch (error) {
      this.log('error', `Failed to start runner instance ${instanceNum}: ${(error as Error).message}`);
      instance.status = 'error';
      this.instances.set(instanceNum, instance);
      this.startingInstances.delete(instanceNum);
    }
  }

  /**
   * Stop a single runner instance. Used for re-registration.
   */
  async stopInstance(instanceNum: number): Promise<void> {
    const instance = this.instances.get(instanceNum);
    if (!instance?.process) {
      return;
    }

    const proc = instance.process;

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.log('warn', `Force killing instance ${instanceNum} process group`);
        this.killProcessGroup(proc, 'SIGKILL');
        setTimeout(resolve, 500);
      }, 5000);

      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      if (!this.killProcessGroup(proc, 'SIGTERM')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  async stop(): Promise<void> {
    // Prevent concurrent stop calls (can happen from multiple quit handlers)
    if (this.stopping) {
      this.log('debug', 'Stop already in progress');
      return;
    }

    if (!this.isRunning()) {
      this.log('info', 'Runner is not running');
      return;
    }

    this.stopping = true;

    this.log('info', `Stopping ${this.instances.size} runner instance${this.instances.size > 1 ? 's' : ''}...`);

    const stopPromises: Promise<void>[] = [];

    for (const [instanceNum, instance] of this.instances) {
      if (instance.process) {
        const proc = instance.process;

        // Check if process is already dead (exitCode is set after exit)
        if (proc.exitCode !== null || proc.killed) {
          this.log('debug', `Instance ${instanceNum} process already exited`);
          continue;
        }

        stopPromises.push(
          new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
              this.log('warn', `Force killing instance ${instanceNum} process group`);
              this.killProcessGroup(proc, 'SIGKILL');
              // Give SIGKILL a moment to take effect
              setTimeout(resolve, 500);
            }, 5000);

            proc.once('exit', () => {
              clearTimeout(timeout);
              resolve();
            });

            // Kill the entire process group (runner + any child processes)
            if (!this.killProcessGroup(proc, 'SIGTERM')) {
              // Process might already be dead
              clearTimeout(timeout);
              resolve();
            }
          })
        );
      }
    }

    // Overall timeout to ensure stop() always completes
    const overallTimeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.log('warn', 'Stop timeout reached, forcing cleanup');
        resolve();
      }, 10000); // 10 second overall timeout
    });

    await Promise.race([
      Promise.all(stopPromises),
      overallTimeout,
    ]);

    // Stop all proxy servers (with timeout)
    if (this.proxyServers.size > 0) {
      const proxyStopPromises: Promise<void>[] = [];
      for (const instanceNum of this.proxyServers.keys()) {
        proxyStopPromises.push(
          this.stopInstanceProxy(instanceNum).catch((proxyErr) => {
            this.log('debug', `Proxy ${instanceNum} stop failed: ${(proxyErr as Error).message}`);
          })
        );
      }
      const proxyStopTimeout = new Promise<void>((resolve) =>
        setTimeout(resolve, 3000)
      );
      await Promise.race([Promise.all(proxyStopPromises), proxyStopTimeout]);
      this.proxyServers.clear();
    }

    this.instances.clear();
    this.startingInstances.clear();
    this.startedAt = null;
    this.stopping = false;
    this.updateStatus('offline');
  }

  /**
   * Release an instance's slot after it finishes a job.
   *
   * Workers are spawned per job: the broker only routes a job message to a
   * worker that was started for that specific target, and deliberately refuses
   * to hand one to a worker with no target assignment. A worker restarted after
   * finishing therefore cannot accept anything, while still occupying a slot
   * that hasAvailableSlot() and spawnWorkerForJob() both consider taken.
   *
   * Keeping one meant that once every slot had run a job, the broker reported
   * "At capacity" for every subsequent job and stopped accepting work entirely,
   * with nothing actually running. Free the slot instead and let the next job
   * spawn a fresh worker bound to its target.
   */
  private releaseInstanceSlot(instanceNum: number): void {
    const instance = this.instances.get(instanceNum);
    if (instance) {
      instance.status = 'offline';
    }
    this.instances.delete(instanceNum);
    this.updateAggregateStatus();
  }

  private countIdleRunners(): number {
    let count = 0;
    for (const [, instance] of this.instances) {
      if (instance.status === 'listening' && !instance.currentJob) {
        count++;
      }
    }
    return count;
  }

  private countBusyRunners(): number {
    let count = 0;
    for (const [, instance] of this.instances) {
      if (instance.status === 'busy') {
        count++;
      }
    }
    return count;
  }

  private async scaleUp(): Promise<void> {
    // Find the first available instance number (not in use and not starting)
    let nextInstance: number | null = null;
    for (let i = 2; i <= this.runnerCount; i++) {
      const existing = this.instances.get(i);
      const isStarting = this.startingInstances.has(i);
      const isActive = existing && existing.status !== 'offline' && existing.status !== 'error';

      if (!isStarting && !isActive) {
        nextInstance = i;
        break;
      }
    }

    if (nextInstance === null) {
      this.log('debug', 'No available instance slots for scale-up');
      return;
    }

    // Configure instance on-demand if not yet configured (lazy configuration)
    if (!this.downloader.isConfigured(nextInstance)) {
      if (this.onConfigurationNeeded) {
        this.log('info', `Instance ${nextInstance} not configured, configuring on-demand...`);
        try {
          await this.onConfigurationNeeded(nextInstance);
          // Verify configuration succeeded
          if (!this.downloader.isConfigured(nextInstance)) {
            this.log('error', `Instance ${nextInstance} still not configured after callback`);
            return;
          }
        } catch (err) {
          this.log('error', `Failed to configure instance ${nextInstance}: ${(err as Error).message}`);
          return;
        }
      } else {
        this.log('warn', `Instance ${nextInstance} not configured and no configuration callback available`);
        return;
      }
    }

    this.log('info', `Scaling up: starting instance ${nextInstance}`);
    await this.startInstance(nextInstance);
  }

  private async parseRunnerOutput(instanceNum: number, line: string): Promise<void> {
    const instance = this.instances.get(instanceNum);
    if (!instance) return;

    // Detect runner ready (listening for jobs)
    if (line.includes('Listening for Jobs')) {
      instance.status = 'listening';
      this.updateAggregateStatus();
      return;
    }

    // Detect fatal errors that require re-configuration
    if (line.includes('runner registration has been deleted') ||
        line.includes('please re-configure')) {
      // Only trigger once per instance (fatalError flag prevents re-trigger)
      if (!instance.fatalError) {
        instance.status = 'error';
        instance.fatalError = true;
        // In proxy-only mode, workers use proxy credentials - the proxy registration was deleted
        // Need to re-register the proxy for the target, not the individual worker
        const targetContext = this.pendingTargetContext.get(String(instanceNum));
        if (targetContext) {
          this.log('error', `Runner ${instanceNum} fatal error - proxy registration for ${targetContext.targetDisplayName} was deleted, attempting re-registration`);
        } else {
          this.log('error', `Runner ${instanceNum} has a fatal error - registration deleted, attempting re-registration`);
        }
        this.updateAggregateStatus();

        // Trigger re-registration asynchronously
        if (this.onReregistrationNeeded) {
          this.onReregistrationNeeded(instanceNum, 'registration_deleted').catch(err => {
            this.log('error', `Re-registration failed for instance ${instanceNum}: ${(err as Error).message}`);
          });
        }
      }
      return;
    }

    // Detect session conflicts - broker proxy should handle this now
    if (line.includes('session for this runner already exists')) {
      // Only trigger once per instance (fatalError flag prevents re-trigger)
      if (!instance.fatalError) {
        instance.status = 'error';
        instance.fatalError = true;
        // In proxy-only mode, session conflicts should be handled by the broker proxy
        this.log('warn', `Runner ${instanceNum} has session conflict - broker proxy should handle this`);
        this.updateAggregateStatus();
      }
      return;
    }

    // Detect other connection errors (runner will retry)
    if (line.includes('Runner connect error') ||
        line.includes('Could not connect to the server')) {
      instance.status = 'error';
      this.updateAggregateStatus();
      return;
    }

    // Detect job start
    const jobStartMatch = line.match(/Running job:\s*(.+)/i);
    if (jobStartMatch) {
      const jobName = jobStartMatch[1].trim();

      // Avoid duplicate job start detection
      if (instance.status === 'busy' && instance.currentJob?.name === jobName) {
        this.log('debug', `[instance ${instanceNum}] Ignoring duplicate job start: ${jobName}`);
        return;
      }

      instance.status = 'busy';

      // Get target context if available (from broker-proxy-service)
      const targetContext = this.consumePendingTargetContext(instance.name);

      // Keep it against this instance. An idle worker that picks a job up
      // never went through spawnWorkerForJob, so this is the only record of
      // which repository the job belongs to - and the policy cannot be
      // resolved without it.
      if (targetContext) {
        this.pendingTargetContext.set(String(instanceNum), targetContext);
      }

      // Use target display name (owner/repo format) for repository if available
      const repository = targetContext?.targetDisplayName || this.config?.url || 'unknown';

      instance.currentJob = {
        name: jobName,
        repository,
        startedAt: new Date().toISOString(),
        id: `job-${++this.jobIdCounter}`,
        targetId: targetContext?.targetId,
        targetDisplayName: targetContext?.targetDisplayName,
        actionsUrl: targetContext?.actionsUrl,
        githubRunId: targetContext?.githubRunId,
        githubJobId: targetContext?.githubJobId,
        githubActor: targetContext?.githubActor,
        githubSha: targetContext?.githubSha,
        githubRef: targetContext?.githubRef,
      };

      this.log('debug', `[instance ${instanceNum}] Job started: ${jobName} (id: ${instance.currentJob.id})${targetContext ? ` from ${targetContext.targetDisplayName}` : ''}${instance.currentJob.actionsUrl ? ` url=${instance.currentJob.actionsUrl}` : ''}`);

      this.addJobToHistory({
        id: instance.currentJob.id,
        jobName: jobName,
        repository: instance.currentJob.repository,
        status: 'running',
        startedAt: instance.currentJob.startedAt,
        runnerName: instance.name,
        actionsUrl: instance.currentJob.actionsUrl,
        githubRunId: instance.currentJob.githubRunId,
        targetId: instance.currentJob.targetId,
        targetDisplayName: instance.currentJob.targetDisplayName,
      });

      this.updateAggregateStatus();

      // Check user filter asynchronously (don't block runner output processing)
      this.checkJobUserFilter(instanceNum, instance.name).catch((err) => {
        this.log('debug', `User filter check failed: ${(err as Error).message}`);
      });

      // Apply the repository's own network policy to this instance's proxy
      this.applyRepoPolicy(instanceNum).catch((err) => {
        this.log('debug', `Repo policy load failed: ${(err as Error).message}`);
      });

      // Scale up if all runners are busy
      const idleCount = this.countIdleRunners();
      if (idleCount === 0 && this.instances.size < this.runnerCount) {
        this.scaleUp().catch((err) => {
          this.log('warn', `Failed to scale up: ${err.message}`);
        });
      }
    }

    // Detect job completion
    const jobCompleteMatch = line.match(/Job .+ completed with result:\s*(\w+)/i);
    if (jobCompleteMatch && instance.currentJob) {
      // Claim the job synchronously. The conclusion lookup below awaits, and
      // the runner can emit its completion line more than once; leaving
      // currentJob set across the await lets a second line re-enter and
      // report the same job as completed twice.
      const job = instance.currentJob;
      instance.currentJob = null;

      const completedAt = new Date().toISOString();

      // Compute runtime in seconds
      const startTime = new Date(job.startedAt).getTime();
      const endTime = new Date(completedAt).getTime();
      const runTimeSeconds = Math.round((endTime - startTime) / 1000);

      const jobId = job.id;
      const githubJobId = job.githubJobId;
      const repository = job.repository;
      const jobName = job.name;

      // Query GitHub API for the actual conclusion (authoritative source)
      let status: JobStatus = 'completed'; // Default fallback
      if (this.getJobConclusion && githubJobId && repository) {
        const [owner, repo] = repository.split('/');
        if (owner && repo) {
          try {
            const conclusion = await this.getJobConclusion(owner, repo, githubJobId);
            if (conclusion === 'success') {
              status = 'completed';
            } else if (conclusion === 'failure') {
              status = 'failed';
            } else if (conclusion === 'cancelled') {
              status = 'cancelled';
            } else if (conclusion === null) {
              // Conclusion not yet set - use runner-reported result
              const result = jobCompleteMatch[1].toLowerCase();
              status = result === 'succeeded' ? 'completed' : result === 'failed' ? 'failed' : 'cancelled';
              this.log('info', `[instance ${instanceNum}] Job completed: ${jobName} conclusion=null, using runner result=${result} → status=${status}`);
            } else {
              // Other conclusions (skipped, etc.) - treat as cancelled
              status = 'cancelled';
            }
            if (conclusion !== null) {
              this.log('info', `[instance ${instanceNum}] Job completed: ${jobName} conclusion=${conclusion} → status=${status}`);
            }
          } catch {
            // Fall back to runner-reported result
            const result = jobCompleteMatch[1].toLowerCase();
            status = result === 'succeeded' ? 'completed' : result === 'failed' ? 'failed' : 'cancelled';
            this.log('warn', `[instance ${instanceNum}] Could not get job conclusion from GitHub, using runner result: ${result}`);
          }
        }
      } else {
        // No API available, use runner-reported result
        const result = jobCompleteMatch[1].toLowerCase();
        status = result === 'succeeded' ? 'completed' : result === 'failed' ? 'failed' : 'cancelled';
        this.log('info', `[instance ${instanceNum}] Job completed: ${jobName} result=${result} → status=${status}`);
      }

      this.updateJobInHistory(jobId, {
        status,
        completedAt,
        runTimeSeconds,
      });

      // Log sandbox policy summary for the completed job
      this.logSandboxSummary(instanceNum, jobName);

      instance.status = 'listening';
      this.updateAggregateStatus();
    }
  }

  /**
   * Load the repository's .localmostrc and apply its network allowlist to the
   * proxy serving this instance.
   *
   * Without this the proxy only ever knows the built-in allowlists, so a repo
   * cannot declare the hosts its own build needs and `strict` is unusable for
   * anything beyond runner infrastructure.
   */
  /**
   * Install a repository's approved policy on an instance's proxy.
   *
   * Proxies are reused across jobs, so this must run before the runner for a
   * job can make any request. Applying it from the runner's "job started" log
   * line is too late: the runner fetches its actions during setup, and an
   * instance that never reached that line would keep the previous job's hosts.
   */
  private async applyPolicyForTarget(
    instanceNum: number,
    targetDisplayName: string,
    githubSha: string,
    workflowName: string
  ): Promise<void> {
    const proxy = this.proxyServers.get(instanceNum);
    if (!proxy || !this.getRepoPolicy) return;

    const repoInfo = parseRepository(targetDisplayName);
    if (!repoInfo) return;

    const { hosts, level } = await this.getRepoPolicy(
      repoInfo.owner,
      repoInfo.repo,
      githubSha,
      workflowName
    );
    proxy.setPolicyAllowedHosts(hosts);
    proxy.setPolicyLevel(level);
    if (hosts.length > 0 || level !== 'strict') {
      this.log('info', `[instance ${instanceNum}] Applied ${level} policy with ${hosts.length} host(s) from ${targetDisplayName} .localmostrc`);
    }
  }

  private async applyRepoPolicy(instanceNum: number): Promise<void> {
    const instance = this.instances.get(instanceNum);
    const proxy = this.proxyServers.get(instanceNum);
    if (!proxy) return;

    // This refines a policy that acquirejob has already installed for the job
    // the worker actually claimed, purely to pick up any per-workflow section
    // now that the job name is known. It must never clear: clearing here wiped
    // a correct policy whenever this path could not identify the job, and the
    // job then ran with no hosts. Staleness is handled where a job is claimed.
    if (!instance?.currentJob || !this.getRepoPolicy) return;

    const spawnContext = this.pendingTargetContext.get(String(instanceNum));
    const targetDisplayName = instance.currentJob.targetDisplayName ?? spawnContext?.targetDisplayName;
    const githubSha = instance.currentJob.githubSha ?? spawnContext?.githubSha;
    if (!targetDisplayName || !githubSha) return;

    await this.applyPolicyForTarget(
      instanceNum,
      targetDisplayName,
      githubSha,
      instance.currentJob.name
    );
  }

  /**
   * Log a summary of sandbox policy enforcement for a completed job.
   */
  private logSandboxSummary(instanceNum: number, jobName: string): void {
    const proxy = this.proxyServers.get(instanceNum);
    if (!proxy) return;

    const stats = proxy.getStats();
    const policyLevel = proxy.getPolicyLevel();
    const policyLabel = SANDBOX_POLICY_LEVEL_DESCRIPTIONS[policyLevel]?.label || policyLevel;

    this.log('info', `[instance ${instanceNum}] Sandbox summary for '${jobName}' (${policyLabel} policy):`);
    this.log('info', `[instance ${instanceNum}]   Network: ${stats.allowedCount} allowed, ${stats.blockedCount} blocked`);

    if (stats.blockedHosts.size > 0) {
      const blockedList = Array.from(stats.blockedHosts).slice(0, 10).join(', ');
      const moreCount = stats.blockedHosts.size > 10 ? ` (+${stats.blockedHosts.size - 10} more)` : '';
      this.log('warn', `[instance ${instanceNum}]   Blocked hosts: ${blockedList}${moreCount}`);

      if (policyLevel === 'strict') {
        this.log('info', `[instance ${instanceNum}]   To allow these hosts, add them to your .localmostrc file, or change sandbox policy level in Settings > Job Security.`);
      }
    }

    // Reset stats for next job
    proxy.resetStats();
  }

  /**
   * Check if a single user is allowed by the trigger-based filter.
   * Used for testing and as a fallback in checkJobUserFilter.
   */
  private isUserAllowed(actorLogin: string): boolean {
    return isUserAllowed(actorLogin, this.getUserFilter?.(), this.getCurrentUserLogin?.());
  }

  /**
   * Decide whether a job may run, without reference to any runner instance.
   *
   * Exposed so the decision can be made before a worker is spawned. Cancelling
   * after the fact leaves untrusted steps running for as long as the check takes.
   *
   * Supports three scopes:
   * - 'everyone': No filtering, all jobs allowed
   * - 'trigger': Check the workflow trigger author only
   * - 'contributors': Check all repository contributors/commit authors
   */
  async evaluateJobFilter(
    owner: string,
    repo: string,
    githubActor: string,
    githubSha?: string
  ): Promise<{ allowed: boolean; reason: string }> {
    const userFilter = this.getUserFilter?.();
    const { scope } = normalizeFilterConfig(userFilter);
    const currentUser = this.getCurrentUserLogin?.();

    if (scope === 'everyone') {
      return { allowed: true, reason: '' };
    }

    if (scope === 'trigger') {
      if (!isUserAllowed(githubActor, userFilter, currentUser)) {
        return { allowed: false, reason: `trigger author '${githubActor}' not in allowed users` };
      }
      return { allowed: true, reason: '' };
    }

    // 'contributors' was chosen precisely because the trigger author alone is
    // not sufficient, so a check that cannot be performed fails closed.
    if (!githubSha) {
      return { allowed: false, reason: 'cannot verify contributors: no commit SHA for this job' };
    }
    if (!this.getAllContributors) {
      return { allowed: false, reason: 'cannot verify contributors: contributor lookup unavailable' };
    }

    try {
      const contributors = await this.getAllContributors(owner, repo, githubSha);
      const result = areAllUsersAllowed(contributors, userFilter, currentUser);
      if (!result.allowed) {
        const list = result.disallowedUsers.slice(0, 3).join(', ');
        const more = result.disallowedUsers.length > 3 ? ` and ${result.disallowedUsers.length - 3} more` : '';
        return { allowed: false, reason: `repo has disallowed contributors: ${list}${more}` };
      }
      return { allowed: true, reason: '' };
    } catch (err) {
      return { allowed: false, reason: `contributor check failed: ${(err as Error).message}` };
    }
  }

  /**
   * Record a job this runner refused, so the refusal is visible.
   *
   * A refused job never reaches a worker, so without this it appears on GitHub
   * as a plain cancellation and does not show up in the app at all - leaving no
   * way to tell a policy refusal from someone pressing cancel.
   */
  recordRefusedJob(details: {
    repository: string;
    jobName: string;
    reason: string;
    actionsUrl?: string;
    githubRunId?: number;
  }): void {
    const now = new Date().toISOString();
    this.addJobToHistory({
      id: `refused-${details.githubRunId ?? Date.now()}`,
      jobName: details.jobName,
      repository: details.repository,
      status: 'cancelled',
      startedAt: now,
      completedAt: now,
      runTimeSeconds: 0,
      error: details.reason,
      actionsUrl: details.actionsUrl,
      githubRunId: details.githubRunId,
    }, false);

    this.log('warn', `Refused ${details.repository}: ${details.reason}`);
    this.onJobEvent?.({
      type: 'refused',
      jobName: details.jobName,
      repository: details.repository,
      status: 'cancelled',
      reason: details.reason,
    });
  }

  /**
   * Cancel a workflow run that must not proceed.
   */
  async cancelRun(owner: string, repo: string, githubRunId: number, reason: string): Promise<void> {
    if (!this.cancelWorkflowRun) {
      this.log('warn', 'Cannot cancel: cancelWorkflowRun not available');
      return;
    }
    try {
      await this.cancelWorkflowRun(owner, repo, githubRunId);
      this.log('info', `Cancelled workflow run ${githubRunId}: ${reason}`);
    } catch (cancelErr) {
      this.log('warn', `Failed to cancel workflow run ${githubRunId}: ${(cancelErr as Error).message}`);
    }
  }

  /**
   * Backstop for a job that reached a runner without passing evaluateJobFilter.
   */
  private async checkJobUserFilter(instanceNum: number, _runnerName: string): Promise<void> {
    const instance = this.instances.get(instanceNum);
    if (!instance?.currentJob) return;

    const { githubActor, githubRunId, targetDisplayName, githubSha } = instance.currentJob;
    if (!githubActor || !githubRunId || !targetDisplayName) {
      this.log('debug', `checkJobUserFilter: missing info (actor=${githubActor}, runId=${githubRunId}, target=${targetDisplayName})`);
      return;
    }

    const repoInfo = parseRepository(targetDisplayName);
    if (!repoInfo) {
      this.log('warn', `Cannot parse owner/repo from target: ${targetDisplayName}`);
      return;
    }

    const { allowed, reason } = await this.evaluateJobFilter(
      repoInfo.owner,
      repoInfo.repo,
      githubActor,
      githubSha
    );
    if (allowed) return;

    this.log('info', `Job not allowed: ${reason}. Cancelling workflow run.`);
    await this.cancelRun(repoInfo.owner, repoInfo.repo, githubRunId, reason);
  }

  private addJobToHistory(job: JobHistoryEntry, announceStart = true): void {
    this.log('debug', `Adding job to history: ${job.id} (${job.jobName})`);
    this.jobHistory.push(job);
    if (this.jobHistory.length > this.maxJobHistory) {
      this.jobHistory = this.jobHistory.slice(-this.maxJobHistory);
    }
    this.saveJobHistory();
    this.onJobHistoryUpdate([...this.jobHistory]); // Send a copy to trigger React update

    if (!announceStart) return;

    // Notify about job start
    this.onJobEvent?.({
      type: 'started',
      jobName: job.jobName,
      repository: job.repository,
    });
  }

  private updateJobInHistory(jobId: string, updates: Partial<JobHistoryEntry>): void {
    const job = this.jobHistory.find((j) => j.id === jobId);
    if (job) {
      this.log('debug', `Updating job ${jobId}: ${JSON.stringify(updates)}`);
      Object.assign(job, updates);
      this.saveJobHistory();
      this.onJobHistoryUpdate([...this.jobHistory]); // Send a copy to trigger React update

      // Notify about job completion if status changed to a terminal state
      if (updates.status && updates.status !== 'running') {
        this.onJobEvent?.({
          type: 'completed',
          jobName: job.jobName,
          repository: job.repository,
          status: updates.status as 'completed' | 'failed' | 'cancelled',
        });
      }
    } else {
      this.log('warn', `Could not find job ${jobId} to update. History has ${this.jobHistory.length} jobs: ${this.jobHistory.map(j => j.id).join(', ')}`);
    }
  }

  private logInstanceOutput(instanceNum: number, level: LogEntry['level'], message: string): void {
    const runnerLogLevel = this.getRunnerLogLevel();
    const messagePriority = LOG_LEVEL_PRIORITY[level as LogLevel] ?? LOG_LEVEL_PRIORITY.info;
    const configuredPriority = LOG_LEVEL_PRIORITY[runnerLogLevel as LogLevel] ?? LOG_LEVEL_PRIORITY.warn;

    if (messagePriority < configuredPriority) {
      return;
    }

    const instanceName = this.instances.get(instanceNum)?.name || `instance-${instanceNum}`;
    const prefix = this.runnerCount > 1 ? `[${instanceName}] ` : '';
    this.log(level, `${prefix}${message}`);
  }

  private log(level: LogEntry['level'], message: string): void {
    this.onLog({
      timestamp: new Date().toISOString(),
      level,
      message,
    });
  }

  private updateStatus(status: RunnerStatus, _errorMessage?: string): void {
    this.onStatusChange({
      status,
      jobName: undefined,
      repository: undefined,
      startedAt: this.startedAt ?? undefined,
    });
  }

  private updateAggregateStatus(): void {
    const state = this.getStatus();
    this.onStatusChange(state);
  }

  private async killStaleProcesses(): Promise<void> {
    // Check sandbox directories for stale PID files
    const sandboxBase = path.join(this.downloader.getBaseDir(), 'sandbox');
    if (!fs.existsSync(sandboxBase)) {
      return;
    }

    const entries = await fs.promises.readdir(sandboxBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Security: Validate path stays within sandbox base
      const sandboxDir = this.validateChildPath(sandboxBase, entry.name);
      if (!sandboxDir) {
        this.log('warn', `Skipping suspicious sandbox directory: ${entry.name}`);
        continue;
      }

      const pidFile = path.join(sandboxDir, 'runner.pid');

      if (!fs.existsSync(pidFile)) continue;

      try {
        const pidStr = await fs.promises.readFile(pidFile, 'utf-8');
        const pid = parseInt(pidStr.trim(), 10);

        if (isNaN(pid)) {
          await fs.promises.unlink(pidFile);
          continue;
        }

        try {
          process.kill(pid, 0);
          this.log('info', `Killing stale runner process ${pid}`);
          process.kill(pid, 'SIGTERM');

          await new Promise((resolve) => setTimeout(resolve, 1000));
          try {
            process.kill(pid, 0);
            process.kill(pid, 'SIGKILL');
          } catch {
            // Process exited after SIGTERM - expected success case
          }
        } catch {
          // Process doesn't exist (ESRCH) - already dead
        }

        await fs.promises.unlink(pidFile);
      } catch {
        // Failed to read/process PID file - non-fatal, continue with other entries
      }
    }
  }

  private async detectStaleRunnerProcesses(): Promise<void> {
    // Scan PID files in sandbox directories to find orphaned processes
    const sandboxBase = path.join(getRunnerDir(), 'sandbox');

    if (!fs.existsSync(sandboxBase)) return;

    try {
      const entries = await fs.promises.readdir(sandboxBase, { withFileTypes: true });

      // Get PIDs we're currently tracking
      const trackedPids = new Set<number>();
      for (const [, instance] of this.instances) {
        if (instance.process?.pid) {
          trackedPids.add(instance.process.pid);
        }
      }

      const orphanedPids: number[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        // Security: Validate path stays within sandbox base
        const sandboxDir = this.validateChildPath(sandboxBase, entry.name);
        if (!sandboxDir) {
          this.log('warn', `Skipping suspicious sandbox directory: ${entry.name}`);
          continue;
        }

        const pidFile = path.join(sandboxDir, 'runner.pid');
        if (!fs.existsSync(pidFile)) continue;

        try {
          const pidStr = await fs.promises.readFile(pidFile, 'utf-8');
          const pid = parseInt(pidStr.trim(), 10);

          if (isNaN(pid) || trackedPids.has(pid)) continue;

          // Check if process is still running (signal 0 doesn't kill, just checks)
          try {
            process.kill(pid, 0);
            // Process exists but we're not tracking it - it's orphaned
            orphanedPids.push(pid);
          } catch {
            // Process doesn't exist - clean up stale PID file
            await fs.promises.unlink(pidFile).catch(() => {
              // PID file cleanup failed - non-fatal
            });
          }
        } catch {
          // Couldn't read PID file - corrupted or permissions, skip
        }
      }

      if (orphanedPids.length > 0) {
        this.log('warn', `Found ${orphanedPids.length} orphaned runner process(es): ${orphanedPids.join(', ')}`);

        for (const pid of orphanedPids) {
          try {
            this.log('info', `Killing orphaned process ${pid}`);
            process.kill(pid, 'SIGTERM');

            await new Promise((resolve) => setTimeout(resolve, 1000));
            try {
              process.kill(pid, 0);
              process.kill(pid, 'SIGKILL');
            } catch {
              // Process exited after SIGTERM - expected success case
            }
          } catch {
            // Process doesn't exist or permission denied - continue with next
          }
        }
      }
    } catch {
      // Error scanning sandbox directories - non-fatal
    }
  }
}
