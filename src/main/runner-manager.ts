import * as path from 'path';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as yaml from 'js-yaml';
import type { DockerPolicy } from '../shared/docker-policy';
import { DockerBackend, noDockerBackend } from './docker/docker-backend';
import { DockerFilterProxy } from './docker/docker-filter-proxy';
import {
  SandboxPolicyLevel, RunnerState, RunnerStatus, LogEntry, RunnerConfig, JobHistoryEntry, JobStatus, LOG_LEVEL_PRIORITY, LogLevel, UserFilterConfig, SANDBOX_POLICY_LEVEL_DESCRIPTIONS } from '../shared/types';
import { DEFAULT_RUNNER_COUNT, DEFAULT_MAX_JOB_HISTORY, MIN_RUNNER_COUNT, MAX_RUNNER_COUNT, DEFAULT_BROKER_PORT } from '../shared/constants';
import { vmWorkerEnv } from './worker-env';
import type { EnvPolicy } from '../shared/policy-types';
import { ProxyServer, ProxyLogEntry } from './proxy-server';
import { GitHubClientError } from './github-client';
import { RunnerDownloader } from './runner-downloader';
import type { IsolationAvailability, IsolationBackend, IsolationJob, WorkerHandle } from './isolation/macos-vm/types';
import { MAX_MAC_VMS } from './isolation/macos-vm/host';
import type { WorkerCredentialFiles } from './worker-credentials';
import type { BrokerJobTarget } from './broker-proxy-service';
import { getConfigPath, getJobHistoryPath, getRunnerDir } from './paths';
import { loadConfig, resolveDockerVmConfig, type DockerVmConfig } from './config';
import { normalizeFilterConfig, isUserAllowed, areAllUsersAllowed, parseRepository } from './runner/user-filter';

/**
 * The filtering docker socket a worker gets, at the root of its sandbox
 * directory. Short and fixed: macOS caps unix socket paths at 104 bytes and
 * truncates silently past that.
 */
const DOCKER_SOCKET_NAME = 'docker.sock';

/** How long a worker is given to stop on SIGTERM before its VM is stopped under it. */
const STOP_GRACE_MS = 5000;

/** The backend a manager made without one has: it runs nothing, and says so. */
const NO_ISOLATION: IsolationBackend = {
  type: 'macos-vm',
  available: () => ({ ok: false, reason: 'this runner was started without a macOS VM backend' }),
  prepare: async () => {
    throw new Error('this runner was started without a macOS VM backend');
  },
  spawnWorker: async () => {
    throw new Error('this runner was started without a macOS VM backend');
  },
  signal: async () => undefined,
  release: async () => undefined,
};

/** A job's history status from the conclusion GitHub gave it. */
function statusForConclusion(conclusion: string): JobStatus {
  if (conclusion === 'success') return 'completed';
  if (conclusion === 'failure') return 'failed';
  // 'cancelled', and the others (skipped, etc.)
  return 'cancelled';
}

/** A job's status from the result a runner's completion line gives. */
function statusForRunnerResult(result: string): JobStatus {
  const lower = result.toLowerCase();
  return lower === 'succeeded' ? 'completed' : lower === 'failed' ? 'failed' : 'cancelled';
}

/**
 * Get the hostname without .local suffix (common on macOS).
 */
function getCleanHostname(): string {
  return os.hostname().replace(/\.local$/, '');
}

interface RunnerInstance {
  /**
   * The stamp of the approved policy this worker was started under (see
   * policyStamp in repo-policy). Its environment is fixed when it starts, so
   * a worker whose stamp no longer matches the approved policy must not
   * serve a job under it.
   */
  policyStamp?: string;
  /**
   * This spawn's own sandbox directory: its runner files, which its VM is
   * given, and its docker socket. No other spawn is ever built there;
   * removed once its VM is released (see releaseSpawn).
   */
  sandboxDir?: string;
  /**
   * The tripwire this spawn's sandbox holds in `_work/.localmost-share`,
   * written before the worker starts: its Docker VM must read it back.
   */
  shareNonce?: string;
  /** This spawn's job as the macOS VM backend knows it, from prepare until release. */
  job?: IsolationJob;
  /** Aborts a prepare still waiting for a VM slot or booting, once the slot is let go. */
  preparing?: AbortController;
  /** Set when a claim found the approved policy had moved; the worker stays constrained. */
  policyDrifted?: boolean;
  /**
   * The job this worker claimed, as the broker reported it: its repository
   * as GitHub names it, commit and workflow. The docker socket opens only for
   * this repository, and only when it is also the one the worker was spawned
   * for; the job-start refresh applies the policy for this job and no other.
   */
  claimedJob?: { repository: string; sha: string; workflow: string };
  /**
   * Set when the worker is finalized and its proxy closed. A policy lookup
   * still in flight from before then must not reopen it.
   */
  policySealed?: boolean;
  /** The worker's runner, in its macOS VM, from its start until it exits. */
  worker: WorkerHandle | null;
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
    githubWorkflow?: string;  // Workflow name from github.workflow (keys workflows.<name> policy)
    /**
     * The result of the last completion line read for this job. Only a
     * reading of the job's output, which the job can forge: the job ends
     * with its worker's exit, and this is weighed only there.
     */
    runnerResult?: JobStatus;
  } | null;
  name: string;
  jobsCompleted: number;
  fatalError: boolean; // Set when runner has an unrecoverable error (e.g., registration deleted)
  /**
   * Set when this spawn took its job, and never cleared: a --once worker has
   * one job, and nothing it prints after taking it - a completion included -
   * is the runner's status or a second job.
   */
  tookJob?: boolean;
}

/** Job event types for notifications */
export type JobEventType = 'started' | 'completed' | 'refused' | 'cancel-failed';

/** Job event data for notifications */
export interface JobEvent {
  type: JobEventType;
  jobName: string;
  repository: string;
  status?: 'completed' | 'failed' | 'cancelled';
  /** Why a refused job was not run, or why its run could not be cancelled */
  reason?: string;
}

/** What a repository's approved policy means for one job at runtime. */
export interface RepoPolicyRuntime {
  /** Hosts the policy declares, on top of runner infrastructure. */
  hosts: string[];
  /** The level the policy asks for, which widens what its proxy allows; strict when it declares none. */
  level: SandboxPolicyLevel;
  /**
   * Paths the policy declares readable. A macOS VM job is given none yet:
   * they are named in the log when its worker starts (see logUnprovided).
   */
  readPaths: string[];
  /** Paths the policy declares writable; as readPaths. */
  writePaths: string[];
  /** The docker actions the policy declares, merged across shared and workflow; empty when it declares none. */
  docker: DockerPolicy;
  /**
   * Which of the app's own environment variables a worker is given, and
   * which it may not be; applied when the worker is spawned. Absent means
   * the policy declares none.
   */
  env?: EnvPolicy;
  /** Hosts the policy denies, resolved per workflow like hosts; absent means none. */
  deniedHosts?: string[];
  /** Paths the policy denies. Nothing of the Mac's filesystem reaches a VM job, so nothing to apply. */
  denyPaths?: string[];
  /**
   * Loopback the policy declares. A macOS VM job reaches only its own proxy
   * and the broker, so this is never applied; it is named in the log when
   * its worker starts.
   */
  loopback?: true | number[];
  /**
   * The identity of the approved policy a worker is started under, the same
   * whichever workflow it is asked for (see policyStamp in repo-policy).
   * Absent, nothing is compared.
   */
  stamp?: string;
}

/** The broker's record of a job a worker claimed. */
export type ClaimedJobTarget = BrokerJobTarget;

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
  /**
   * The repository and commit of a job the worker in a slot claims, from the
   * broker - which answers only for a job it delivered to that worker.
   */
  getJobTarget?: (instanceNum: number, jobId: string) => ClaimedJobTarget | undefined;
  /**
   * The port the broker listens on, the one loopback port every worker's
   * proxy keeps open. The default broker port when absent.
   */
  getBrokerPort?: () => number;
  /** The repository's approved policy, resolved for the job about to run. */
  getRepoPolicy?: (owner: string, repo: string, sha: string, workflowName: string) => Promise<RepoPolicyRuntime>;
  /** Called when a job starts or completes (for notifications) */
  onJobEvent?: (event: JobEvent) => void;
  /**
   * Which worker was reserved for an incoming job, once the slot is chosen.
   * The broker binds that worker's session to the job's target by name, rather
   * than by whichever session happens to poll first.
   */
  onWorkerReservedForJob?: (targetId: string, instanceNum: number, jobId?: string) => void;
  /** Withdraw that reservation when the worker never starts. */
  onWorkerReservationCancelled?: (targetId: string, instanceNum: number, jobId?: string) => void;
  /**
   * The broker address for a worker being started in a slot, carrying a key
   * the broker checks on every request; the target is the one it is spawned
   * for, if any. Revoked when the worker exits.
   */
  issueBrokerUrl?: (instanceNum: number, targetId?: string) => string | undefined;
  revokeBrokerUrl?: (instanceNum: number) => void;
  /**
   * Runner credentials for the worker just given a broker address: a key made
   * for this start and a token endpoint at that address. The registration's
   * own key never goes into a sandbox, which the job can read.
   */
  issueWorkerCredential?: (instanceNum: number) => Promise<WorkerCredentialFiles | undefined>;
  /**
   * The daemon a worker's permitted container requests go to: each worker's
   * own Docker VM. Without one, no worker has Docker (noDockerBackend).
   */
  dockerBackend?: DockerBackend;
  /** The dockerVm settings: the boot timeout and the spare, here. Read at each spawn. */
  getDockerVmConfig?: () => DockerVmConfig;
  /**
   * Where every job runs: a fresh macOS VM per job (createMacVmMode's
   * backend). Without one the manager takes no job, and its status says why.
   */
  isolation?: IsolationBackend;
}

/**
 * How long a worker spawned for a specific job may sit without acquiring it
 * before its slot is reclaimed.
 *
 * GitHub keeps retrying assignment for about ten minutes, so this is well
 * inside the window where the job can still land on another worker.
 */
export const UNCLAIMED_WORKER_TIMEOUT_MS = 2 * 60 * 1000;

export class RunnerManager {
  private instances: Map<number, RunnerInstance> = new Map();
  /** Deadlines for workers spawned for a job that have not yet acquired one. */
  private acquireDeadlines: Map<number, NodeJS.Timeout> = new Map();
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
  private getJobTarget?: (instanceNum: number, jobId: string) => ClaimedJobTarget | undefined;
  private getBrokerPort?: () => number;
  private onJobEvent?: (event: JobEvent) => void;
  private onWorkerReservedForJob?: (targetId: string, instanceNum: number, jobId?: string) => void;
  private onWorkerReservationCancelled?: (targetId: string, instanceNum: number, jobId?: string) => void;
  private issueBrokerUrl?: (instanceNum: number, targetId?: string) => string | undefined;
  private revokeBrokerUrl?: (instanceNum: number) => void;
  private issueWorkerCredential?: (instanceNum: number) => Promise<WorkerCredentialFiles | undefined>;
  private jobHistory: JobHistoryEntry[] = [];
  private jobIdCounter = 0;
  private maxJobHistory = DEFAULT_MAX_JOB_HISTORY;

  // Proxy servers for network isolation and logging (one per instance)
  private proxyServers: Map<number, ProxyServer> = new Map();

  // Filtering docker sockets, one per spawn: minted with the worker, bound
  // to its repository's policy on claim, stopped when it exits.
  private dockerProxies: Map<number, DockerFilterProxy> = new Map();
  private readonly dockerBackend: DockerBackend;
  private readonly getDockerVmConfig: () => DockerVmConfig;
  private readonly isolation: IsolationBackend;
  /** Why the last look found no job could get a VM, or null; each change is logged once. */
  private vmUnavailableReason: string | null = null;

  // Flag to track intentional stops vs job completion restarts
  private stopping = false;

  // Runner downloader for directory management
  private readonly downloader: RunnerDownloader;

  // Config path for localmost settings
  private readonly configPath: string;

  // Current runner version
  private runnerVersion: string | null = null;

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
  // Keyed by slot number, or 'next' for the job admission is handing to spawnWorkerForJob
  // githubRepo is owner/repo as GitHub reports it: the name the policy was
  // approved and checked under, which for an organization target the display
  // name is not.
  private pendingTargetContext: Map<string, { targetId: string; targetDisplayName: string; actionsUrl?: string; githubRunId?: number; githubJobId?: number; githubActor?: string; githubSha?: string; githubRef?: string; githubWorkflow?: string; jobId?: string; githubRepo?: string }> = new Map();

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
    this.getBrokerPort = options.getBrokerPort;
    this.onJobEvent = options.onJobEvent;
    this.onWorkerReservedForJob = options.onWorkerReservedForJob;
    this.onWorkerReservationCancelled = options.onWorkerReservationCancelled;
    this.issueBrokerUrl = options.issueBrokerUrl;
    this.revokeBrokerUrl = options.revokeBrokerUrl;
    this.issueWorkerCredential = options.issueWorkerCredential;
    this.dockerBackend = options.dockerBackend ?? noDockerBackend;
    this.getDockerVmConfig =
      options.getDockerVmConfig ??
      (() => resolveDockerVmConfig(undefined, { cores: os.cpus().length, memoryBytes: os.totalmem() }));
    this.isolation = options.isolation ?? NO_ISOLATION;

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
    this.removeLeftoverHistoryTemps();
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

          // Get the highest job ID to continue the counter. Refused entries
          // draw on it too (refused-<run>-<n>), and must not repeat an id.
          for (const job of this.jobHistory) {
            const match = job.id.match(/^(?:job|refused-\d+)-(\d+)$/);
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
   * Remove the temporary files of saves that never reached their rename.
   *
   * A crash between a save's write and its rename leaves one behind, and no
   * later save uses its random name again. Only names saveJobHistory makes
   * are removed; this runs before any save of this process.
   */
  private removeLeftoverHistoryTemps(): void {
    const dir = path.dirname(this.jobHistoryPath);
    const prefix = `${path.basename(this.jobHistoryPath)}.`;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(prefix) && /^[0-9a-f]{12}\.tmp$/.test(name.slice(prefix.length))) {
          fs.unlinkSync(path.join(dir, name));
        }
      }
    } catch {
      // No directory yet, or unreadable: nothing to clean, and saving reports its own failures.
    }
  }

  /**
   * Save job history to disk.
   */
  private saveJobHistory(): void {
    // Written whole beside the file and renamed over it, so a full disk or a
    // crash mid-write leaves the previous history rather than a truncated
    // file loadJobHistory cannot parse, which would lose all of it. The
    // random suffix keeps two writers off one temporary file.
    const temp = `${this.jobHistoryPath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const data = {
        version: 1,
        savedAt: new Date().toISOString(),
        jobs: this.jobHistory,
      };
      fs.writeFileSync(temp, JSON.stringify(data, null, 2), { flag: 'wx' });
      fs.renameSync(temp, this.jobHistoryPath);
    } catch (err) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // Never created, or already renamed into place.
      }
      this.log('warn', `Failed to save job history: ${(err as Error).message}`);
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
   * Set pending target context for a job admission has accepted.
   * Called by admission (job-admission.ts) just before spawnWorkerForJob, which takes it.
   * @param runnerName 'next' for the worker about to be spawned, or a slot number
   * @param targetId The target ID from which the job was received
   * @param targetDisplayName Human-readable target name
   * @param actionsUrl The GitHub Actions URL for this job
   * @param githubRunId The GitHub workflow run ID (for cancellation)
   * @param githubJobId The GitHub job ID (for querying conclusion)
   * @param githubActor The username who triggered the workflow (for user filtering)
   * @param githubSha The commit SHA that triggered the workflow
   * @param githubRef The branch/tag ref (e.g., refs/heads/main)
   * @param githubWorkflow The workflow name (github.workflow), which keys per-workflow policy
   * @param jobId The broker's id for the job, so a worker that never takes it can give it up
   * @param githubRepo owner/repo as GitHub reports it, which keys the job's policy
   */
  setPendingTargetContext(runnerName: string, targetId: string, targetDisplayName: string, actionsUrl?: string, githubRunId?: number, githubJobId?: number, githubActor?: string, githubSha?: string, githubRef?: string, githubWorkflow?: string, jobId?: string, githubRepo?: string): void {
    this.pendingTargetContext.set(runnerName, { targetId, targetDisplayName, actionsUrl, githubRunId, githubJobId, githubActor, githubSha, githubRef, githubWorkflow, jobId, githubRepo });
    this.log('debug', `Set pending target context for ${runnerName}: ${targetDisplayName} (runId=${githubRunId}, jobId=${githubJobId}, actor=${githubActor}, sha=${githubSha?.slice(0, 7)})`);
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

    // Not started is offline. Started with no instances is not: workers are
    // spawned per job, so an idle pool holds none, and that is the resting
    // state of a healthy runner rather than a stopped one. Calling it offline
    // made `localmost status` contradict a running app once the CLI began
    // reading this instead of the state machine.
    if (!this.startedAt) {
      return {
        status: 'offline',
        startedAt: undefined,
      };
    }
    if (this.instances.size === 0) {
      // Idle, and taking no job while no job can get a VM: offline, with why.
      const availability = this.isolation.available();
      if (!availability.ok) {
        return { status: 'offline', startedAt: this.startedAt, error: unavailableMessage(availability) };
      }
      return {
        status: 'listening',
        startedAt: this.startedAt,
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
      // Consider running if a worker is active OR status indicates active state
      if (instance.worker || instance.status === 'starting' || instance.status === 'listening' || instance.status === 'busy') {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether the pool is started: initialize() has run and stop() has not
   * since. Not isRunning(), which counts workers, and an idle pool has none.
   */
  isInitialized(): boolean {
    return this.startedAt !== null;
  }

  isConfigured(): boolean {
    // In proxy-only mode, check for proxy credentials instead of individual worker configs
    return this.downloader.hasAnyProxyCredentials();
  }

  /**
   * Initialize the runner manager without starting any workers.
   * Used for on-demand worker spawning where broker proxy triggers worker starts.
   */
  async initialize(): Promise<void> {
    // A second initialize while workers are live (a Start click overlapping
    // auto-start) would re-run the stale-process sweep against them.
    if (this.isRunning()) {
      this.log('info', 'Runner is already running');
      return;
    }
    this.startedAt = new Date().toISOString();
    this.updateStatus('starting');
    // The previous pool's records go now, not after the sweep: the broker is
    // already handing out jobs, and a worker spawned during the sweep must
    // not be forgotten with them - its exit is identity-gated, so nothing
    // would ever finalize it.
    this.instances.clear();
    this.startingInstances.clear();

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

    const displayName = this.getStatusDisplayName();
    this.log('info', `Runner manager initialized (max ${this.maxSlots()}, ${displayName})`);

    this.stopping = false;

    // Don't start any instances - workers will be spawned on demand. Until
    // the golden image is ready none can be, and the status says so.
    this.vmReady();
    this.updateAggregateStatus();
  }

  /**
   * Look again at whether a job can get a VM, after the golden image's
   * status changed: logs the change and publishes the status it makes.
   */
  refreshAvailability(): void {
    this.vmReady();
    if (this.startedAt && !this.stopping) this.updateAggregateStatus();
  }

  /**
   * Whether a job can get a macOS VM now. Each change is logged once: a
   * pool with no golden image refuses every capacity check, and saying so at
   * each one would fill the log.
   */
  private vmReady(): boolean {
    const availability = this.isolation.available();
    const reason = availability.ok ? null : unavailableMessage(availability);
    if (reason !== this.vmUnavailableReason) {
      this.vmUnavailableReason = reason;
      if (reason) this.log('warn', reason);
      else this.log('info', 'A macOS VM can be started for a job; taking jobs');
    }
    return reason === null;
  }

  /**
   * How many workers may run at once: the runner count, and never more than
   * the two macOS VMs a Mac may run. A third job would only wait for a VM
   * after GitHub had handed it over.
   */
  private maxSlots(): number {
    return Math.min(this.runnerCount, MAX_MAC_VMS);
  }

  /**
   * Check if there's an available slot for a new worker.
   * Used by broker proxy to decide whether to acquire a job.
   */
  hasAvailableSlot(): boolean {
    // No golden image, no job: the broker leaves it with GitHub rather than
    // acquire one nothing can run.
    if (!this.vmReady()) return false;
    for (let i = 1; i <= this.maxSlots(); i++) {
      if (this.slotIsFree(i)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether a slot can be given to a new worker: nothing is running in it,
   * whatever its status says.
   *
   * A status of 'error' is not an exit. A worker whose status went to error
   * while it runs keeps its job, sandbox, proxy and broker key; a second one
   * started in its slot would share the slot's proxy and key with it, and
   * leave the first one's exit to find the slot taken and skip its sweep.
   */
  private slotIsFree(instanceNum: number): boolean {
    const instance = this.instances.get(instanceNum);
    if (!instance) return true;
    return (instance.status === 'offline' || instance.status === 'error') && !instance.worker;
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
    for (let i = 1; i <= this.maxSlots(); i++) {
      if (this.reservedSlots.has(i) || this.startingInstances.has(i)) continue;
      if (this.slotIsFree(i)) {
        this.reservedSlots.add(i);
        return i;
      }
    }
    return null;
  }

  private releaseSlotReservation(instanceNum: number): void {
    this.reservedSlots.delete(instanceNum);
  }

  /**
   * Give up the job a worker was spawned for, when that worker will never take
   * it: withdraw the broker's binding and drop the job from its queue, and
   * forget the job here. Left at the broker, the next worker for the repository
   * runs it in place of its own; left here, a later start of the slot is built
   * from the abandoned job's repository and policy.
   */
  private abandonJobFor(instanceNum: number): void {
    const context = this.pendingTargetContext.get(String(instanceNum));
    if (context?.targetId) {
      this.onWorkerReservationCancelled?.(context.targetId, instanceNum, context.jobId);
    }
    this.pendingTargetContext.delete(String(instanceNum));
    // The key was issued when the proxy was created, before the setup that
    // failed here. Revoke it, or a worker that never started keeps a valid
    // broker URL until the slot is reused. Idempotent with the exit/reap
    // revocations.
    this.revokeBrokerUrl?.(instanceNum);
  }

  /**
   * Start the worker for the job admission just put in 'next'. True once a
   * worker process exists for it; false when none was started, in which case
   * nothing else will ever run the job - only the worker spawned for a job
   * may take it - and the caller drops it at the broker.
   */
  async spawnWorkerForJob(): Promise<boolean> {
    // Take the context before waiting for a slot. 'next' is a single shared
    // slot, so a job arriving during the wait would otherwise overwrite it and
    // this worker would start with another repository's context.
    const claimedContext = this.pendingTargetContext.get('next');
    if (claimedContext) {
      this.pendingTargetContext.delete('next');
    }

    // Every job runs in a macOS VM; without a golden image there is none to
    // start, and the job is given back rather than held for one.
    if (!this.vmReady()) {
      this.log('error', `This job will not run: ${this.vmUnavailableReason}`);
      return false;
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
      // Not put back in 'next' for something else to pick up: nothing else
      // may take the job, so the caller drops it instead.
      this.log('error', 'No worker slot became available; this job will not run');
      return false;
    }

    // Get the target context for this job (claimed above, before the wait)
    const targetContext = claimedContext;
    if (!targetContext) {
      this.log('error', 'No target context for spawned worker');
      this.releaseSlotReservation(instanceNum);
      return false;
    }

    // Announce the pairing before the worker exists, so its very first session
    // request already has a binding waiting and cannot lose a race to another
    // instance polling on the same target.
    if (targetContext.targetId) {
      this.onWorkerReservedForJob?.(targetContext.targetId, instanceNum, targetContext.jobId);
    }

    this.log('info', `Spawning worker ${instanceNum} for incoming job from ${targetContext.targetDisplayName}...`);

    // Keyed by instance so startInstance can install the policy for this job
    // before the runner starts, and the job start reads it from here.
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
        this.abandonJobFor(instanceNum);
        this.releaseSlotReservation(instanceNum);
        return false;
      }
    } else {
      this.log('error', `Proxy credentials not found for target ${targetContext.targetId}`);
      this.abandonJobFor(instanceNum);
      this.releaseSlotReservation(instanceNum);
      return false;
    }

    // Configure and start the instance
    // The instance will connect to broker proxy and pick up the queued job
    try {
      await this.startInstance(instanceNum);
      // startInstance reports most failures by marking the instance and
      // returning. A slot with no worker never started one.
      if (!this.instances.get(instanceNum)?.worker) {
        this.abandonJobFor(instanceNum);
        return false;
      }
      return true;
    } catch (err) {
      // Only on failure. Withdrawing in the finally below took the announcement
      // back on the success path too - the broker recorded the pairing and lost
      // it again seconds before the worker's session arrived, so every session
      // found no expectation and fell back to arrival order, which is the very
      // thing the announcement exists to replace.
      this.abandonJobFor(instanceNum);
      throw err;
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
      // Per-worker secret. Every worker's proxy is on the Mac's loopback; a
      // guest reaches only its own, through its relay, and the token keeps
      // anything else that reaches one from routing its traffic through
      // another worker's proxy and taking that repository's allowlist. It
      // rides in the proxy URL this worker is given.
      authToken: randomBytes(24).toString('hex'),
      onJobAcquired: async (jobId: string) => {
        // The worker behind this proxy just claimed a job, and this is the
        // one that has to carry its policy. The id is read from the request
        // body, which job code can write, so it is resolved only among the
        // jobs the broker delivered to this slot's worker: naming another
        // repository's job resolves to nothing and closes the policy below.
        const target = this.getJobTarget?.(instanceNum, jobId);
        if (!target?.targetDisplayName || !target.githubSha) {
          // Saying the policy is closed is not the same as closing it. This
          // proxy may still hold the last job's hosts, so clear them: an
          // unidentifiable job gets nothing rather than someone else's grants.
          const staleProxy = this.proxyServers.get(instanceNum);
          if (staleProxy) this.closeProxyPolicy(staleProxy);
          this.log('warn', `[instance ${instanceNum}] No target for acquired job ${jobId}; policy closed`);
          return;
        }
        // The claimed job's own identity, not the one the worker was spawned
        // for: its repository as GitHub names it, which the policy was
        // approved under, and its workflow, which keys workflows.<name>.
        await this.applyPolicyForTarget(
          instanceNum,
          target.repository ?? target.targetDisplayName,
          target.githubSha,
          target.githubWorkflow ?? '',
          true
        );
      },
      onLog: (entry: ProxyLogEntry) => {
        // Skip logging routine localhost message polling (very noisy). Only
        // the broker's: a declared loopback port is a grant worth auditing.
        if (
          !entry.blocked &&
          entry.reason === 'infrastructure' &&
          (entry.host === 'localhost' || entry.host === '127.0.0.1')
        ) {
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

  /** The broker's port, which every worker's proxy keeps open on loopback. */
  private brokerPort(): number {
    return this.getBrokerPort?.() ?? DEFAULT_BROKER_PORT;
  }

  /**
   * Close a proxy to runner infrastructure: no policy hosts, no denies,
   * strict, and on loopback the broker alone. Every place a job's policy is
   * withdrawn goes through here, so no part of it can be left behind.
   */
  private closeProxyPolicy(proxy: ProxyServer): void {
    proxy.setPolicyAllowedHosts([]);
    proxy.setPolicyDeniedHosts([]);
    proxy.setLoopbackPolicy(this.brokerPort(), undefined);
    proxy.setPolicyLevel('strict');
  }

  /**
   * The repository a job context's policy belongs to: owner/repo as GitHub
   * reported it for the job - the name admission checked and the policy was
   * approved under - or, for a context recorded without it, the target's
   * display name.
   */
  private policyRepository(context: { targetDisplayName: string; githubRepo?: string }): string {
    return context.githubRepo ?? context.targetDisplayName;
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
   * Serve a worker its own filtering docker socket, before the worker exists.
   *
   * The socket is born denying everything: a speculatively spawned worker
   * has a socket before it has a job, and default-deny is the state it
   * starts in rather than one set afterwards. Policy is bound on claim.
   */
  private async startDockerProxy(
    instanceNum: number,
    socketPath: string,
    sandboxDir: string,
    shareNonce: string
  ): Promise<DockerFilterProxy> {
    // A leftover from a spawn that failed after this point.
    await this.stopDockerProxy(instanceNum);
    const vmConfig = this.getDockerVmConfig();
    const spawnContext = this.pendingTargetContext.get(String(instanceNum));
    const log = (entry: { level: 'debug' | 'info' | 'warn'; message: string }) =>
      this.log(entry.level, `[docker ${instanceNum}] ${entry.message}`);
    // The worker's daemon: its own Docker VM, booted at the job's first
    // Docker request that needs one, when the claimed job's policy grants
    // Docker (contract §5.4).
    const worker = this.dockerBackend.forWorker({
      slot: instanceNum,
      sandboxDir,
      sandboxId: path.basename(sandboxDir),
      shareNonce,
      spawnRepository: spawnContext ? this.policyRepository(spawnContext) : undefined,
      // Read when needed: the slot's proxy is reused across its jobs, and its
      // token rotates at every start and every exit.
      proxy: () => {
        const proxy = this.proxyServers.get(instanceNum);
        return { port: proxy?.getPort() ?? 0, url: proxy?.getProxyUrl() ?? '' };
      },
      log,
    });
    const socket = new DockerFilterProxy({
      backend: this.dockerBackend,
      worker,
      bootTimeoutMs: vmConfig.bootTimeoutSec * 1000,
      onLog: log,
    });
    await socket.start(socketPath);
    this.dockerProxies.set(instanceNum, socket);
    this.log('debug', `Docker socket for instance ${instanceNum} listening at ${socketPath}; bound when a job is claimed`);
    if (vmConfig.prewarm) worker.prewarm();
    return socket;
  }

  private async stopDockerProxy(instanceNum: number): Promise<void> {
    const socket = this.dockerProxies.get(instanceNum);
    if (!socket) return;
    try {
      // Stopping removes the containers the job left, which takes a moment.
      // The socket stays in the map until that is done, so the next spawn in
      // this slot and a full stop both wait for it: a second stop() joins the
      // first.
      await socket.stop();
    } catch {
      // Already stopped, or its directory already removed - gone either way.
    }
    if (this.dockerProxies.get(instanceNum) === socket) this.dockerProxies.delete(instanceNum);
  }

  /**
   * Start a slot's worker, for the job spawnWorkerForJob placed in the slot.
   * Every worker it starts gets the acquisition deadline.
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

    // Never over a worker that is still running, whatever its status: its
    // job keeps the slot's proxy and broker key until it exits.
    if (this.instances.get(instanceNum)?.worker) {
      this.log('warn', `Instance ${instanceNum} still has a worker running; not starting another in its slot`);
      return;
    }

    this.startingInstances.add(instanceNum);
    const instanceName = this.getInstanceName(instanceNum);

    // Set 'starting' status immediately so UI shows it during sandbox build
    const existingInstance = this.instances.get(instanceNum);
    const instance: RunnerInstance = {
      worker: null,
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
        }
      );
    } catch (error) {
      this.log('error', `Failed to build sandbox for instance ${instanceNum}: ${(error as Error).message}`);
      instance.status = 'error';
      this.updateAggregateStatus();
      this.startingInstances.delete(instanceNum);
      return;
    }
    instance.sandboxDir = sandboxDir;

    // The share's tripwire, written before anything runs in the sandbox, so
    // the Docker VM can prove it was given this directory (contract §1).
    let shareNonce: string;
    try {
      shareNonce = this.downloader.writeShareNonce(sandboxDir);
      instance.shareNonce = shareNonce;
    } catch (error) {
      this.log('error', `Cannot prepare the work folder of instance ${instanceNum}: ${(error as Error).message}`);
      instance.status = 'error';
      this.releaseSpawn(instanceNum, instance);
      this.updateAggregateStatus();
      this.startingInstances.delete(instanceNum);
      return;
    }

    // Verify config is in sandbox
    const runnerConfigFile = path.join(sandboxDir, '.runner');
    if (!fs.existsSync(runnerConfigFile)) {
      this.log('warn', `Runner instance ${instanceNum} not configured, skipping`);
      instance.status = 'error';
      this.releaseSpawn(instanceNum, instance);
      this.updateAggregateStatus();
      this.startingInstances.delete(instanceNum);
      return;
    }

    // This start's broker address. The broker refuses any request without a
    // key it issued, and takes the worker's identity from the key.
    const brokerUrl = this.issueBrokerUrl?.(
      instanceNum,
      this.pendingTargetContext.get(String(instanceNum))?.targetId
    );
    if (brokerUrl) {
      try {
        const runnerConfig = JSON.parse(
          String(fs.readFileSync(runnerConfigFile, 'utf-8')).replace(/^\uFEFF/, '')
        );
        runnerConfig.serverUrlV2 = brokerUrl;
        // The listener also opens a connection to serverUrl, the pipelines
        // service, on its own token - unless serverUrl is the broker address
        // too, when it skips it. GitHub would refuse the token this worker is
        // given, and the broker is all the listener needs: its sessions,
        // messages and job acquisition all go there.
        runnerConfig.serverUrl = brokerUrl;
        fs.writeFileSync(runnerConfigFile, JSON.stringify(runnerConfig, null, 2));

        // The sandbox holds no credentials until now: buildSandbox copies only
        // the .runner from the config, never the registration's key.
        const credential = await this.issueWorkerCredential?.(instanceNum);
        if (!credential) {
          throw new Error('the broker made no key for it');
        }
        fs.writeFileSync(
          path.join(sandboxDir, '.credentials'),
          JSON.stringify(credential.credentials, null, 2),
          { mode: 0o600 }
        );
        fs.writeFileSync(
          path.join(sandboxDir, '.credentials_rsaparams'),
          JSON.stringify(credential.rsaParams),
          { mode: 0o600 }
        );
      } catch (error) {
        this.log('error', `Cannot give instance ${instanceNum} its broker address: ${(error as Error).message}`);
        this.revokeBrokerUrl?.(instanceNum);
        instance.status = 'error';
        this.releaseSpawn(instanceNum, instance);
        this.updateAggregateStatus();
        this.startingInstances.delete(instanceNum);
        return;
      }
    }

    try {
      // Start proxy for this instance (or reuse existing)
      let proxy = this.proxyServers.get(instanceNum);
      if (!proxy) {
        proxy = await this.startInstanceProxy(instanceNum);
      }

      // Install the policy before the runner exists. A reused proxy still
      // holds the last job's hosts until this runs.
      this.closeProxyPolicy(proxy);
      // Rotate the proxy token every start (finalizeInstance rotates at exit
      // too). The proxy is reused across a slot's jobs, so without this the
      // previous job's credential would stay valid for this job's allowlist
      // after its policy is replaced.
      proxy.rotateAuthToken(randomBytes(24).toString('hex'));
      const startupContext = this.pendingTargetContext.get(String(instanceNum));
      if (startupContext?.targetDisplayName && startupContext.githubSha) {
        await this.applyPolicyForTarget(
          instanceNum,
          this.policyRepository(startupContext),
          startupContext.githubSha,
          ''
        );
      }

      // A worker is credentialed for one repository and runs a single job, so
      // its environment can come from that repository's approved policy. It
      // is fixed at spawn, which is why a policy change must retire the
      // workers started under the old one.
      const spawnPolicy = await this.spawnPolicy(this.pendingTargetContext.get(String(instanceNum)));
      if (spawnPolicy) this.logUnprovided(instanceNum, spawnPolicy);

      // The runner's own settings and this worker's proxy, which the guest
      // reaches through its relay at the same address, and what the env
      // policy allows of the app's environment - nothing else of it.
      const env = vmWorkerEnv(process.env, spawnPolicy?.env, proxy.getProxyUrl());

      // The worker's filtering docker socket, in its own sandbox directory,
      // so its path is new with every job and it goes with the sandbox. No
      // job reaches it yet: a job whose policy grants Docker is refused at
      // admission until the relay into the VM exists.
      const dockerSocketPath = path.join(sandboxDir, DOCKER_SOCKET_NAME);
      const dockerSocket = await this.startDockerProxy(instanceNum, dockerSocketPath, sandboxDir, shareNonce);
      // A stop() in the meantime finalized this instance; a VM started for
      // it now would run a job nothing is waiting for.
      if (instance.policySealed) {
        throw new Error('its slot was let go while it started');
      }

      // The job's VM: a slot (waiting behind the two a Mac may run), a clone
      // of the golden image restored or booted, its guest prepared. A stop
      // while this waits aborts it (releaseSpawn).
      const job: IsolationJob = {
        key: `${instanceNum}-${path.basename(sandboxDir)}`,
        proxyPort: proxy.getPort(),
        brokerPort: this.brokerPort(),
        sandboxDir,
        runnerVersion: this.runnerVersion,
      };
      instance.job = job;
      instance.preparing = new AbortController();
      this.log('info', `Starting a macOS VM for instance ${instanceNum}...`);
      await this.isolation.prepare(job, instance.preparing.signal);
      instance.preparing = undefined;
      if (instance.policySealed) {
        throw new Error('its slot was let go while its VM started');
      }

      const worker = await this.isolation.spawnWorker(job, ['--once'], env);
      instance.worker = worker;
      instance.policyStamp = spawnPolicy?.stamp;
      this.log('info', `Runner instance ${instanceNum} started in its macOS VM (guest pid ${worker.pid})`);

      // Don't set 'listening' until we see "Listening for Jobs". Until then
      // the instance stays 'starting', which keeps its slot from being
      // reserved for another job.

      // Parsed only while this is the slot's worker. Its last lines and its
      // exit can come after the slot was let go, when a new spawn may hold
      // it; parseRunnerOutput reads the slot, and a dead worker's line read
      // there could start a job on the new one. Still logged. The agent
      // hands over whole lines, each cut at 16 KiB.
      const isCurrent = () => this.instances.get(instanceNum) === instance && instance.worker === worker;
      worker.on('stdout', (line: string) => {
        if (isCurrent()) this.parseRunnerOutput(instanceNum, line);
        this.logInstanceOutput(instanceNum, 'debug', line);
      });
      worker.on('stderr', (line: string) => {
        if (isCurrent()) this.parseRunnerOutput(instanceNum, line); // Also parse stderr for status
        this.logInstanceOutput(instanceNum, 'error', line);
      });

      let exited = false;
      const onExit = (code: number | null, signal: string | null): void => {
        if (exited) return;
        exited = true;
        instance.worker = null;

        // Only while this is still the slot's worker: a reaped or completed
        // worker's exit can land after the next worker was spawned into the
        // slot. A worker let go before it exited had its VM released then.
        if (this.instances.get(instanceNum) === instance) {
          // A job still current here is over, and this is where it is
          // closed: a completion line does not close it, being one the job
          // can write itself, and one can go unread besides - split by a \n
          // in the name, or never written by a worker that died mid-job.
          // Left open, its history read 'running', with Cancel offered,
          // until the app next started.
          if (instance.currentJob) {
            const job = instance.currentJob;
            this.logSandboxSummary(instanceNum, job.name);
            this.closeJobOnExit(instanceNum, job, code, signal).catch((err) => {
              this.log('debug', `Closing job ${job.id} on exit failed: ${(err as Error).message}`);
            });
          }
          // The VM goes with its job, and whatever the job left running in
          // it with the VM.
          this.finalizeInstance(instanceNum);
          if (this.acquireDeadlines.has(instanceNum)) {
            this.abandonJobFor(instanceNum);
          }
          this.disarmAcquireDeadline(instanceNum);
          this.pendingTargetContext.delete(String(instanceNum));
        }

        instance.currentJob = null;

        // Minted for this spawn, so it dies with it - unless a later spawn
        // for the same slot has already replaced it.
        if (this.dockerProxies.get(instanceNum) === dockerSocket) {
          this.stopDockerProxy(instanceNum).catch(() => {});
        }

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

        // A reaped worker can report code 0 after the reap freed its slot,
        // and possibly after a job refilled it. Freeing the slot again would
        // drop the replacement and seal its proxy.
        if (this.instances.get(instanceNum) !== instance) return;

        instance.jobsCompleted++;
        this.log('info', `Runner instance ${instanceNum} completed job #${instance.jobsCompleted}`);
        this.releaseInstanceSlot(instanceNum);
      };
      worker.on('exit', onExit);

      // Spawned for a specific job: if the broker never routes that job here,
      // this worker will long-poll forever and hold its slot. Give it a
      // deadline. One started with no pending target gets one too: only the
      // worker spawned for a job may take it, so that one never gets a job,
      // and without a deadline it held the slot until the app restarted.
      this.armAcquireDeadline(instanceNum);
      // Successfully started - clear the starting flag
      this.startingInstances.delete(instanceNum);
    } catch (error) {
      this.startingInstances.delete(instanceNum);
      // Let go while it started - a stop, a reap - and finalized there: its
      // slot is not this start's to mark any more.
      if (this.instances.get(instanceNum) !== instance || instance.policySealed) {
        this.log('info', `Runner instance ${instanceNum} did not start: ${(error as Error).message}`);
        this.releaseSpawn(instanceNum, instance);
        return;
      }
      this.log('error', `Failed to start runner instance ${instanceNum}: ${(error as Error).message}`);
      instance.status = 'error';
      await this.stopDockerProxy(instanceNum);
      // The proxy may already carry this job's policy, on a token given to a
      // runner that never came up. Close and rotate now, as finalizeInstance
      // does for one that did, rather than leave both live until the slot is
      // next started.
      const proxy = this.proxyServers.get(instanceNum);
      if (proxy) {
        this.closeProxyPolicy(proxy);
        proxy.rotateAuthToken(randomBytes(24).toString('hex'));
      }
      // The broker key was issued before this failure, and its /w/ URL is now
      // in the (unstarted) runner config. Revoke it, or a valid credential
      // outlives a worker that never came up.
      this.revokeBrokerUrl?.(instanceNum);
      if (!instance.worker) this.releaseSpawn(instanceNum, instance);
      this.updateAggregateStatus();
    }
  }

  /**
   * Let a spawn's VM go and remove its sandbox, once: a prepare still
   * waiting for a slot or booting is aborted, the VM is stopped and its
   * clone deleted - with whatever of the job still ran in it - and then the
   * sandbox, which nothing reads once the VM is gone. Asynchronous; a
   * failure is logged, and the next startup's sweeps remove what is left.
   */
  private releaseSpawn(instanceNum: number, instance: RunnerInstance): void {
    instance.preparing?.abort();
    instance.preparing = undefined;
    const { job, sandboxDir } = instance;
    instance.job = undefined;
    instance.sandboxDir = undefined;
    if (!job && !sandboxDir) return;
    void (async () => {
      if (job) {
        await this.isolation.release(job).catch((err: Error) =>
          this.log('warn', `Could not release the macOS VM of instance ${instanceNum}; the next startup will: ${err.message}`)
        );
      }
      if (sandboxDir) {
        await this.downloader.removeSandbox(sandboxDir).catch((err: Error) =>
          this.log('warn', `Could not remove ${path.basename(sandboxDir)}; the next startup will: ${err.message}`)
        );
      }
    })();
  }

  /**
   * Stop a single runner instance: SIGTERM to its runner, and its VM stopped
   * under it if it has not exited within the grace. Used for re-registration
   * and to retire a worker.
   */
  async stopInstance(instanceNum: number): Promise<void> {
    const instance = this.instances.get(instanceNum);
    const worker = instance?.worker;
    const job = instance?.job;
    if (!worker || !job) {
      return;
    }

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.log('warn', `Instance ${instanceNum} did not stop; stopping its macOS VM`);
        void this.isolation.release(job).finally(resolve);
      }, STOP_GRACE_MS);

      worker.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      void this.isolation.signal(job, 'SIGTERM');
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
      if (instance.worker) stopPromises.push(this.stopInstance(instanceNum));
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

    // Each worker's docker socket dies with its process; this catches the
    // ones whose exit never reached us.
    await Promise.all([...this.dockerProxies.keys()].map((instanceNum) => this.stopDockerProxy(instanceNum)));

    for (const instanceNum of [...this.acquireDeadlines.keys()]) {
      this.disarmAcquireDeadline(instanceNum);
    }
    // Revoke keys and release VMs before the map is cleared, or a late exit
    // event finds its instance already gone and skips this - leaving a
    // stopped worker's broker credential valid and its VM running. A worker
    // still starting has its VM's prepare aborted here.
    for (const instanceNum of this.instances.keys()) {
      this.finalizeInstance(instanceNum);
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
  /**
   * Release the slot of a worker that was spawned for a job but never got one.
   *
   * A worker is `--once`: it long-polls until a job arrives, runs it, and
   * exits. When the broker never routes a job to it - the message was skipped
   * at capacity, or the session bound to a different worker - it waits
   * forever, so the exit handler that frees its slot never runs. Once every
   * slot is held by one of these, the broker reports "At capacity" for every
   * subsequent job and the pool stops accepting work with nothing running.
   *
   * This is the same death spiral releaseInstanceSlot() addresses for workers
   * that finish a job, reached by the path where no job ever starts.
   */
  /** Start the acquisition deadline for a worker that has not taken a job. */
  private armAcquireDeadline(instanceNum: number): void {
    this.disarmAcquireDeadline(instanceNum);
    const timer = setTimeout(() => {
      this.acquireDeadlines.delete(instanceNum);
      this.reapUnclaimedWorker(instanceNum);
    }, UNCLAIMED_WORKER_TIMEOUT_MS);
    timer.unref?.();
    this.acquireDeadlines.set(instanceNum, timer);
  }

  /** Stand down the deadline once the worker has its job, or has gone away. */
  private disarmAcquireDeadline(instanceNum: number): void {
    const timer = this.acquireDeadlines.get(instanceNum);
    if (timer) {
      clearTimeout(timer);
      this.acquireDeadlines.delete(instanceNum);
    }
  }

  private reapUnclaimedWorker(instanceNum: number): void {
    const instance = this.instances.get(instanceNum);
    if (!instance) return;

    // It got what it was spawned for; leave it alone.
    if (instance.currentJob || instance.status === 'busy') return;

    // Say which job died, not just that a slot came back. GitHub fails a job
    // that reports no progress for 600s; this reap happens at 120s. Without
    // naming it the app showed a healthy spawn and heartbeats straight through,
    // and nothing connected the reclaimed slot to the job GitHub failed minutes
    // later - a consumer had two runs die exactly that way and could not tell
    // them from an idle runner.
    const context = this.pendingTargetContext.get(String(instanceNum));
    this.log(
      'warn',
      `Runner instance ${instanceNum} never acquired a job, reclaiming its slot` +
        (context?.targetDisplayName ? ` (job from ${context.targetDisplayName})` : '')
    );
    if (context) {
      this.recordRefusedJob({
        repository: this.policyRepository(context),
        jobName: context.githubWorkflow ?? 'job',
        reason:
          'accepted but never started: a runner was spawned for this job and the job was never ' +
          'routed to it. GitHub fails a job that makes no progress for 600s.',
        actionsUrl: context.actionsUrl,
        githubRunId: context.githubRunId,
        status: 'failed',
      });
    }
    this.abandonJobFor(instanceNum);
    // A --once worker that never acquired a job never exits, so the exit
    // handler's cleanup would not run; releaseInstanceSlot finalizes the
    // instance itself, which stops its VM with the listener in it.
    this.releaseInstanceSlot(instanceNum);
  }

  /**
   * Release a slot's per-worker resources: its broker key, its proxy's
   * policy and token, and its VM and sandbox. Called whenever an instance is
   * finished with - a worker exit, a reap, or stop() clearing the pool - so a
   * stopped or gone worker never leaves a usable /w/ credential or a running
   * VM behind. `finished` is the instance when the slot no longer holds it.
   * Idempotent.
   */
  private finalizeInstance(instanceNum: number, finished?: RunnerInstance): void {
    this.revokeBrokerUrl?.(instanceNum);
    // The proxy is the other credential a finished worker leaves behind: its
    // token and the job's hosts would stay live until the slot is next
    // started, which may be never. Close the policy, drop every connection
    // and rotate now. startInstance rotates again for its own worker;
    // nothing legitimate holds this token in between.
    const proxy = this.proxyServers.get(instanceNum);
    const instance = finished ?? this.instances.get(instanceNum);
    // A policy lookup begun before this - a claim, a job start - resolves
    // after it and must find the worker sealed rather than reopen the proxy.
    if (instance) instance.policySealed = true;
    if (proxy) {
      this.closeProxyPolicy(proxy);
      proxy.rotateAuthToken(randomBytes(24).toString('hex'));
    }
    if (instance) this.releaseSpawn(instanceNum, instance);
  }

  private releaseInstanceSlot(instanceNum: number): void {
    this.disarmAcquireDeadline(instanceNum);
    const instance = this.instances.get(instanceNum);
    if (instance) {
      instance.status = 'offline';
    }
    this.instances.delete(instanceNum);
    // The context describes the job this slot just finished. Left behind, the
    // next worker to take the slot is judged against the previous repository -
    // its docker socket refuses the job it is actually running, and a spawn
    // that records no context of its own would resolve the previous
    // repository's filesystem policy.
    this.pendingTargetContext.delete(String(instanceNum));
    // Freeing the slot is the one point every finished worker passes through:
    // a clean exit and the reap of a worker that never took its job both end
    // here, and the reaped worker never exits on its own. Finalize here -
    // revoke the broker key, stop the VM, remove the sandbox - or a finished
    // worker's URL stays usable and its VM runs on until the slot is reused.
    // Idempotent with the exit handler's own call.
    this.finalizeInstance(instanceNum, instance);
    this.updateAggregateStatus();
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

  /**
   * Record the job a worker has started, from its start line. Once per
   * worker: a worker runs with --once, so a second start is the job's output.
   */
  private recordJobStart(instanceNum: number, jobName: string): void {
    const instance = this.instances.get(instanceNum);
    if (!instance) return;

    // A worker runs with --once: one spawn is exactly one job. So a start on
    // a worker that has taken its job - even one whose completion has been
    // read - is never a second job; it is the job's output echoing
    // something that looks like one.
    if (instance.tookJob || instance.status === 'busy' || instance.currentJob) {
      this.log(
        'debug',
        `[instance ${instanceNum}] Ignoring job start while already running ${instance.currentJob?.name ?? 'a job'}: ${jobName}`
      );
      return;
    }

    instance.status = 'busy';
    instance.tookJob = true;

    // The job's context is the one spawnWorkerForJob stored under this slot's
    // number before the worker started: only a worker spawned and announced
    // for a job can take one, so its own slot is the only place to look.
    // It stays there, since the policy and the filter backstop read it from
    // there too. 'next' is admission's hand-off to spawnWorkerForJob, never
    // a worker's.
    const targetContext = this.pendingTargetContext.get(String(instanceNum));

    // The job's own owner/repo. An organization target's display name is
    // the organization, and recording that left the history, the
    // notification and Cancel - which splits this into owner and repo -
    // with no repository to name.
    const repository = (targetContext && this.policyRepository(targetContext)) || this.config?.url || 'unknown';

    // It got its job; the acquisition deadline no longer applies.
    this.disarmAcquireDeadline(instanceNum);

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
      githubWorkflow: targetContext?.githubWorkflow,
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
  }

  /**
   * Close the history entry of a job whose worker has exited. A --once
   * worker exits right after its job, and the exit is the one end a job
   * cannot forge: its completion line it can (see parseRunnerOutput).
   *
   * GitHub's conclusion when it has one. Otherwise what the exit says - a
   * signal or a stop is a cancel, any exit but a clean one a failed job -
   * and after a clean exit the result of the last completion line read,
   * which the runner writes after anything the job put there. That line can
   * only turn a clean exit's 'completed' into 'failed' or 'cancelled', which
   * the job could do by failing; it never makes a crash, a signal or a stop
   * read as a success.
   */
  private async closeJobOnExit(
    instanceNum: number,
    job: NonNullable<RunnerInstance['currentJob']>,
    code: number | null,
    signal: string | null
  ): Promise<void> {
    let status: JobStatus =
      signal !== null || this.stopping ? 'cancelled' : code === 0 ? (job.runnerResult ?? 'completed') : 'failed';
    const [owner, repo] = job.repository.split('/');
    if (this.getJobConclusion && job.githubJobId && owner && repo) {
      try {
        const conclusion = await this.getJobConclusion(owner, repo, job.githubJobId);
        if (conclusion !== null) status = statusForConclusion(conclusion);
      } catch {
        // Fall back to what the exit says.
      }
    }
    this.log('info', `[instance ${instanceNum}] Job completed: ${job.name} with its worker's exit (code=${code}, signal=${signal}) → status=${status}`);

    // The filter backstop may have closed it while the conclusion was looked
    // up: it stopped the job, and its record of that stands.
    const entry = this.jobHistory.find((j) => j.id === job.id);
    if (!entry || entry.status !== 'running') return;
    const completedAt = new Date().toISOString();
    this.updateJobInHistory(job.id, {
      status,
      completedAt,
      runTimeSeconds: Math.round((Date.parse(completedAt) - Date.parse(job.startedAt)) / 1000),
    });
  }

  private async parseRunnerOutput(instanceNum: number, line: string): Promise<void> {
    const instance = this.instances.get(instanceNum);
    if (!instance) return;

    // Detect job start.
    //
    // Anchored, because this reads the job's own output: any text a job prints
    // can contain "Running job: x" - a commit message, a PR title, a checked-out
    // file - and an unanchored match turned that into a phantom job, complete
    // with history entry, notification, and a worker marked busy. The runner
    // emits this at the start of a line, optionally behind its own timestamp.
    //
    // The name is the workflow's to spell, and only \n ends a line here, so
    // the name matches any character (the s flag): without it a CR, U+2028 or
    // U+2029 in the name failed the match, the start went unread, and the
    // runner-shaped line the name carried next was read as the runner's own
    // status.
    const jobStartMatch = line.match(/^\s*(?:\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?:?\s*)?Running job:\s*(.+?)\s*$/is);
    if (jobStartMatch) {
      this.recordJobStart(instanceNum, jobStartMatch[1].trim());
      // A start line is nothing else, whatever its job name says.
      return;
    }

    // The runner's own status. None of it is read from a worker that has
    // taken its job: the job's output reaches this parser too, and a job named
    // or printing "Runner connect error" marked its live worker 'error' - the
    // slot free for the next job - while one saying "please re-configure" had
    // the target re-registered under it. Nor once that job's completion has
    // been read, since the job can print a completion line first. A worker
    // with a job keeps it until the job ends, whatever its connection does
    // meanwhile; a registration or session problem shows again at the next
    // worker's start, before it has a job. Each check is anchored, as the job
    // start is, to the line the runner itself writes, behind its timestamp at
    // most.
    if (!instance.tookJob) {
      // Detect runner ready (listening for jobs)
      if (/^\s*(?:\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?:?\s*)?Listening for Jobs\s*$/i.test(line)) {
        instance.status = 'listening';
        this.updateAggregateStatus();
        return;
      }

      // Detect fatal errors that require re-configuration
      if (/^\s*(?:\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?:?\s*)?(?:Failed to create a session\.\s*)?The runner registration has been deleted from the server, please re-configure\b/i.test(line)) {
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
      if (/^\s*(?:\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?:?\s*)?(?:A|The) session for this runner already exists\b/i.test(line)) {
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

      // Detect other connection errors (runner will retry). The Listener
      // (v2.336.0) writes "Runner connect error: ..."; "Could not connect to
      // the server" has no known source in it and is kept, anchored, from
      // before.
      if (/^\s*(?:\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?:?\s*)?(?:Runner connect error:|Could not connect to the server\b)/i.test(line)) {
        instance.status = 'error';
        this.updateAggregateStatus();
        return;
      }
    }

    // Detect job completion. Anchored like the start: a step can print
    // "Job x completed with result: Succeeded" anywhere in its output, and
    // an unanchored match ended the job there - its worker shown idle and
    // its history closed while its steps were still running. Its name matches
    // any character, as the start's does.
    //
    // Even anchored, it does not end the job. The name is the workflow's,
    // and what it carries after a \n is a line of its own, which can be
    // this one to the letter, for the very name the start recorded:
    // read as the end, it closed the job with the result it named, cleared
    // it from the worker and marked the worker listening while the job ran
    // on - its slot held, Cancel gone, the worker shown idle and sleep
    // protection off - and the real result was never recorded. Nothing
    // before the worker's exit tells the two apart, and a --once worker
    // exits right after its job, so the exit ends it (closeJobOnExit). The
    // result is noted for that, the runner's own line coming last.
    const jobCompleteMatch = line.match(
      /^\s*(?:\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?:?\s*)?Job\s+(.+)\s+completed with result:\s*(\w+)\s*$/is
    );
    if (jobCompleteMatch && instance.currentJob) {
      const job = instance.currentJob;
      job.runnerResult = statusForRunnerResult(jobCompleteMatch[2]);
      this.log('debug', `[instance ${instanceNum}] Job ${job.name}: completion line read, result=${jobCompleteMatch[2]}; closed when its worker exits`);
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
  /**
   * Retire the workers a repository's policy change has made stale.
   *
   * A worker's environment is fixed at spawn, so one started under the old
   * policy would run the next job under it. Idle workers are stopped now;
   * a busy worker keeps the job it already claimed, which was validated
   * against the policy in force when it claimed it, and exits after it anyway.
   */
  async retireWorkersForRepository(repository: string, exceptInstance?: number): Promise<void> {
    for (const [instanceNum, instance] of this.instances) {
      // A worker that has just claimed a job looks idle: currentJob is not set
      // until the runner logs "Running job". Stopping it would strand a job
      // GitHub has already handed out, and the run would fail on timeout with
      // no steps recorded. It is --once, so it retires after this job anyway.
      if (instanceNum === exceptInstance) continue;
      // By the repository the worker's policy was resolved for, as GitHub
      // names it - the name approvals are keyed on - and without regard to
      // case, as GitHub compares them: a policy changed for bfulton/localmost
      // is the policy of a worker spawned for BFulton/Localmost.
      const context = this.pendingTargetContext.get(String(instanceNum));
      const target = context ? this.policyRepository(context) : instance.currentJob?.targetDisplayName;
      if (target?.toLowerCase() !== repository.toLowerCase()) continue;

      if (instance.currentJob) {
        // Leave the stamp alone. Overwriting it made the drift check fire on
        // the job this worker is already running - the one this branch exists
        // to protect. The worker exits after it anyway, being --once.
        this.log('info', `[instance ${instanceNum}] Policy changed for ${repository}; this worker exits after its current job`);
        continue;
      }

      this.log('info', `[instance ${instanceNum}] Policy changed for ${repository}; retiring idle worker`);
      try {
        await this.stopInstance(instanceNum);
      } catch (err) {
        this.log('warn', `Could not retire instance ${instanceNum}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * The approved policy for the job a worker is about to be spawned for, as
   * its spawn reads it: before the workflow is known. Null - nothing beyond
   * the baseline, and no stamp to compare - when the job has no context, no
   * commit, or its policy cannot be read; the baseline is the safe state to
   * run under, so there is nothing to detect drift from.
   */
  private async spawnPolicy(
    context?: { targetDisplayName: string; githubSha?: string; githubRepo?: string }
  ): Promise<RepoPolicyRuntime | null> {
    if (!context?.targetDisplayName || !context.githubSha || !this.getRepoPolicy) return null;
    const repoInfo = parseRepository(this.policyRepository(context));
    if (!repoInfo) return null;
    try {
      return await this.getRepoPolicy(repoInfo.owner, repoInfo.repo, context.githubSha, '');
    } catch {
      return null;
    }
  }

  /**
   * Say, as a worker starts, what of its approved policy a macOS VM job is
   * not given: filesystem grants, which wait for VM shares, and loopback,
   * since the guest reaches only its proxy and the broker. A deny needs
   * nothing: no path of the Mac reaches the guest.
   */
  private logUnprovided(instanceNum: number, policy: RepoPolicyRuntime): void {
    const grants = [...policy.readPaths.map((p) => `read ${p}`), ...policy.writePaths.map((p) => `write ${p}`)];
    if (grants.length > 0) {
      this.log('warn', `[instance ${instanceNum}] Filesystem grants are not provided in the macOS VM yet; this job runs without: ${grants.join(', ')}`);
    }
    if (policy.loopback !== undefined) {
      this.log('warn', `[instance ${instanceNum}] network.loopback is ignored: a macOS VM job reaches only its proxy and the broker`);
    }
  }

  private async applyPolicyForTarget(
    instanceNum: number,
    /** owner/repo as GitHub names it, falling back to the target's display name. */
    repository: string,
    githubSha: string,
    workflowName: string,
    /**
     * Whether this is the worker claiming a job. Drift is only meaningful
     * there: once a job is running, its boundary is already fixed and
     * re-deciding mid-job would constrain the job this check exists to protect.
     */
    isClaim = false
  ): Promise<void> {
    const claimProxy = this.proxyServers.get(instanceNum);
    if (!claimProxy || !this.getRepoPolicy) return;

    // The worker this policy is for. The lookup below awaits, and in that
    // time the worker can exit - its proxy closed by finalizeInstance - and
    // the slot be given to another job's worker, which reuses the proxy and
    // the slot number. Whatever the lookup returns belongs to this worker
    // only, so everything after it is checked against this one.
    const instance = this.instances.get(instanceNum);
    const repoInfo = parseRepository(repository);
    if (!repoInfo || !instance) {
      // A claim this cannot place gets nothing, as an unidentifiable one
      // does: returning alone would leave whatever the proxy held before -
      // the spawn-time policy - on a job nobody has matched it to.
      if (isClaim) {
        this.closeProxyPolicy(claimProxy);
        this.log('warn', `[instance ${instanceNum}] Cannot place claimed job from ${repository}; policy closed`);
      }
      return;
    }

    // What the worker claimed, as the broker reported it. Recorded before
    // anything below can bail so the docker socket is judged against it
    // however the rest of the policy fares.
    if (isClaim) instance.claimedJob = { repository, sha: githubSha, workflow: workflowName };

    const policy = await this.getRepoPolicy(
      repoInfo.owner,
      repoInfo.repo,
      githubSha,
      workflowName
    );
    if (this.instances.get(instanceNum) !== instance || instance.policySealed) {
      this.log('debug', `[instance ${instanceNum}] ${repository} policy resolved after its worker finished; not applied`);
      return;
    }
    const proxy = this.proxyServers.get(instanceNum);
    if (!proxy) return;
    const { hosts, level } = policy;

    // The worker's environment was fixed at spawn and cannot be changed now.
    // If the approved policy has moved since, this worker would run the job
    // under the old one - so it is constrained rather than run as approved.
    // Approving through the app retires workers eagerly; this also covers
    // approving through the CLI, which writes the cache directly.
    if (instance.policyDrifted) {
      this.log(
        'debug',
        `[instance ${instanceNum}] Policy drifted for this worker; leaving it constrained rather than reapplying`
      );
      return;
    }

    if (isClaim && instance.policyStamp && instance.policyStamp !== policy.stamp) {
      // What was fixed at spawn cannot be updated, so the job runs under what
      // was approved when the worker started. That was approved by the
      // machine owner, just not most recently. Network is cut back to runner infrastructure and the
      // worker is retired so nothing further lands on it - this constrains the
      // job rather than refusing it, which the proxy cannot do on its own.
      // The docker socket stays as it was born, closed: nothing on this path
      // opens it. Sticky, because the job-start refresh runs without isClaim
      // and so never re-checks drift - without this it fell straight through
      // to the widening below, restoring the hosts and rebinding the socket
      // this branch had just closed. The current policy's denied hosts still
      // apply: a deny only ever narrows what is left.
      instance.policyDrifted = true;
      this.closeProxyPolicy(proxy);
      proxy.setPolicyDeniedHosts(policy.deniedHosts ?? []);
      this.dockerProxies.get(instanceNum)?.staysClosed("the repository's policy changed since this worker started, so the Docker socket stays closed");
      this.log(
        'warn',
        `[instance ${instanceNum}] ${repository} policy changed since this worker started; running with runner infrastructure only and retiring the worker`
      );
      await this.retireWorkersForRepository(repository, instanceNum);
      return;
    }

    proxy.setPolicyAllowedHosts(hosts);
    proxy.setPolicyDeniedHosts(policy.deniedHosts ?? []);
    proxy.setPolicyLevel(level);
    this.bindDockerSocket(instanceNum, repository, policy.docker);
    if (hosts.length > 0 || level !== 'strict') {
      this.log('info', `[instance ${instanceNum}] Applied ${level} policy with ${hosts.length} host(s) from ${repository} .localmostrc`);
    }
  }

  /**
   * Bind a worker's docker socket to the repository whose job it runs.
   *
   * The socket is born denying everything and opens only for the repository
   * this worker was spawned for and claimed its job from. A worker spawned
   * for one repository that claims another's job would otherwise run that
   * job with the first repository's container grants; its socket stays
   * closed instead - and stays closed when the job-started line later
   * attributes the job to the spawn repository, which is why the claim is
   * recorded on the instance rather than checked once. A worker with no
   * record of what it was spawned for - an idle listener - was spawned for
   * no repository, and its socket never opens.
   */
  private bindDockerSocket(instanceNum: number, repository: string, docker: DockerPolicy): void {
    const socket = this.dockerProxies.get(instanceNum);
    if (!socket) return;

    // Repositories by the name GitHub reports, compared as GitHub compares
    // them, without regard to case.
    const spawnContext = this.pendingTargetContext.get(String(instanceNum));
    const spawnedFor = spawnContext ? this.policyRepository(spawnContext) : undefined;
    const claimedFor = this.instances.get(instanceNum)?.claimedJob?.repository ?? repository;
    const same = (name: string | undefined): boolean => name?.toLowerCase() === repository.toLowerCase();
    if (!same(spawnedFor) || !same(claimedFor)) {
      this.log(
        'warn',
        `[instance ${instanceNum}] Docker socket stays closed: spawned for ${spawnedFor ?? 'no job'}, claimed ${claimedFor}, policy is for ${repository}`
      );
      socket.staysClosed(`the claim is for ${claimedFor}, not ${spawnedFor ?? 'no job'}, so the Docker socket stays closed`);
      return;
    }
    socket.bind(repository, docker);
  }

  private async applyRepoPolicy(instanceNum: number): Promise<void> {
    const instance = this.instances.get(instanceNum);
    if (!this.proxyServers.get(instanceNum)) return;

    // This refines a policy that acquirejob has already installed for the job
    // the worker actually claimed. It must never clear: clearing here wiped
    // a correct policy whenever this path could not identify the job, and the
    // job then ran with no hosts. Staleness is handled where a job is claimed.
    if (!instance?.currentJob || !this.getRepoPolicy) return;

    // Only for the job the broker says this worker claimed - its repository,
    // commit and workflow, which keys workflows.<name> - never for the one it
    // was spawned for or the name the runner prints: those are what the
    // worker was expected to take, not what it took. A worker with no claim
    // on record keeps the policy it has.
    const claimed = instance.claimedJob;
    if (!claimed) return;

    await this.applyPolicyForTarget(instanceNum, claimed.repository, claimed.sha, claimed.workflow);
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
        this.log('info', `[instance ${instanceNum}]   To allow these hosts, add them to network.allow in the repository's .localmostrc, or raise its level.`);
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
   * - 'contributors': Check the trigger author, the repository's contributors,
   *   and the author of every commit since those were fetched - one with no
   *   linked account is allowed by no filter
   */
  async evaluateJobFilter(
    owner: string,
    repo: string,
    githubActor: string | undefined,
    githubSha?: string
  ): Promise<{ allowed: boolean; reason: string }> {
    const userFilter = this.getUserFilter?.();
    const { scope } = normalizeFilterConfig(userFilter);
    const currentUser = this.getCurrentUserLogin?.();

    if (scope === 'everyone') {
      return { allowed: true, reason: '' };
    }

    // Both remaining scopes check who set the run going. 'contributors' adds
    // the authors of the code to that, never replaces it: a run whose commit
    // is the default branch head (issue_comment, pull_request_target) has an
    // all-trusted history whoever triggered it. A job whose actor could not
    // be read cannot be shown to be anyone allowed.
    if (!githubActor) {
      return { allowed: false, reason: 'cannot identify who triggered this job' };
    }
    if (!isUserAllowed(githubActor, userFilter, currentUser)) {
      return { allowed: false, reason: `trigger author '${githubActor}' not in allowed users` };
    }
    if (scope === 'trigger') {
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
   * way to tell a policy refusal from someone pressing cancel. Returns the
   * entry's id, for the cancel that follows to note a failure on.
   */
  recordRefusedJob(details: {
    repository: string;
    jobName: string;
    reason: string;
    actionsUrl?: string;
    githubRunId?: number;
    /** 'cancelled' for a policy refusal; 'failed' for a job that never started. */
    status?: 'cancelled' | 'failed';
  }): string {
    const status = details.status ?? 'cancelled';
    const now = new Date().toISOString();
    // Unique per entry: one run can have several jobs refused, and a later
    // note (a failed cancel) must land on its own job's entry.
    const id = `refused-${details.githubRunId ?? Date.now()}-${++this.jobIdCounter}`;
    this.addJobToHistory({
      id,
      jobName: details.jobName,
      repository: details.repository,
      status,
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
      status,
      reason: details.reason,
    });
    return id;
  }

  /**
   * Cancel a workflow run that must not proceed. Resolves to whether GitHub
   * took the cancel.
   *
   * A failure is recorded on the job's history entry and notified, not only
   * logged: a run meant to be cancelled that was not goes on running its
   * other jobs, while the history said it was refused and nothing said
   * otherwise. The entry is `historyId` when the caller knows it, else the
   * latest one for the run. A job with no run id has no run to cancel, which
   * is a failure like any other.
   *
   * A run that has already finished is not a failure: GitHub answers 409
   * when, say, several of a run's jobs are refused one after another and
   * the first cancel has ended it, or someone cancelled it on GitHub.
   */
  async cancelRun(
    owner: string,
    repo: string,
    githubRunId: number | undefined,
    reason: string,
    historyId?: string
  ): Promise<boolean> {
    let failure: string;
    if (githubRunId === undefined) {
      failure = 'no workflow run id';
    } else if (!this.cancelWorkflowRun) {
      failure = 'cancelWorkflowRun not available';
    } else {
      try {
        await this.cancelWorkflowRun(owner, repo, githubRunId);
        this.log('info', `Cancelled workflow run ${githubRunId}: ${reason}`);
        return true;
      } catch (cancelErr) {
        if (cancelErr instanceof GitHubClientError && cancelErr.status === 409) {
          this.log('info', `Workflow run ${githubRunId} has already finished; nothing to cancel (${reason})`);
          return true;
        }
        failure = (cancelErr as Error).message;
      }
    }
    this.log('warn', `Failed to cancel workflow run ${githubRunId ?? '(none)'}: ${failure}`);

    const note = `cancel failed: ${failure}`;
    let entry: JobHistoryEntry | undefined;
    for (let i = this.jobHistory.length - 1; i >= 0 && !entry; i--) {
      const candidate = this.jobHistory[i];
      if (historyId ? candidate.id === historyId : githubRunId !== undefined && candidate.githubRunId === githubRunId) {
        entry = candidate;
      }
    }
    if (entry) {
      // Onto the entry found, not looked up again by id.
      this.log('debug', `Updating job ${entry.id}: ${note}`);
      entry.error = entry.error ? `${entry.error}; ${note}` : note;
      this.saveJobHistory();
      this.onJobHistoryUpdate([...this.jobHistory]);
    }
    this.onJobEvent?.({
      type: 'cancel-failed',
      jobName: entry?.jobName ?? `run ${githubRunId ?? '(none)'}`,
      repository: entry?.repository ?? `${owner}/${repo}`,
      reason: note,
    });
    return false;
  }

  /**
   * Backstop for a job that reached a runner without passing evaluateJobFilter.
   */
  private async checkJobUserFilter(instanceNum: number, _runnerName: string): Promise<void> {
    const instance = this.instances.get(instanceNum);
    if (!instance?.currentJob) return;
    // The worker the job is running on. A --once worker runs one job, so while
    // it holds the slot, it is this job's.
    const worker = instance.worker;
    const job = instance.currentJob;

    // No actor is a verdict for evaluateJobFilter, not a reason to skip it,
    // and no run id is only a cancel that cannot be made: the worker is
    // stopped all the same. The filter needs the repository.
    const { githubActor, githubRunId, targetDisplayName, githubSha } = instance.currentJob;
    if (!targetDisplayName) {
      this.log('debug', `checkJobUserFilter: missing info (actor=${githubActor}, runId=${githubRunId}, target=${targetDisplayName})`);
      return;
    }

    // The job's repository as GitHub reported it: an organization target's
    // display name is the organization, which names no repository to check.
    const repository = this.pendingTargetContext.get(String(instanceNum))?.githubRepo ?? targetDisplayName;
    const repoInfo = parseRepository(repository);
    if (!repoInfo) {
      this.log('warn', `Cannot parse owner/repo from target: ${repository}`);
      return;
    }

    const { allowed, reason } = await this.evaluateJobFilter(
      repoInfo.owner,
      repoInfo.repo,
      githubActor,
      githubSha
    );
    if (allowed) return;

    this.log('info', `Job not allowed: ${reason}. Cancelling workflow run and stopping its worker.`);
    this.updateJobInHistory(job.id, { error: reason });
    // Stopped whether or not the cancel goes through, and without waiting for
    // it: until the worker is gone the job's steps are running, and a cancel
    // that failed would leave them running to the end. Only the worker the
    // check began with - if the slot has a new one, that one is not this
    // job's. GitHub shows a job stopped this way as lost rather than
    // cancelled when the cancel has not landed first.
    const stop = worker && this.instances.get(instanceNum) === instance && instance.worker === worker
      ? this.stopInstance(instanceNum)
      : Promise.resolve();
    await Promise.all([
      this.cancelRun(repoInfo.owner, repoInfo.repo, githubRunId, reason, job.id),
      stop,
    ]);
    // A refused job is cancelled, whatever else closed it. The worker's exit
    // (closeJobOnExit) may have got there first, as 'completed' or 'failed'
    // from GitHub's conclusion or the exit, and this record replaces it. An
    // exit that lands after this finds the entry closed and leaves it.
    const entry = this.jobHistory.find((j) => j.id === job.id);
    if (entry && entry.status !== 'cancelled') {
      const completedAt = new Date().toISOString();
      this.updateJobInHistory(job.id, {
        status: 'cancelled',
        completedAt,
        runTimeSeconds: Math.round((Date.parse(completedAt) - Date.parse(job.startedAt)) / 1000),
      });
    }
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

}

/** Why no job is taken, for the log and the runner's status. */
function unavailableMessage(availability: IsolationAvailability): string {
  return `Taking no jobs: ${availability.reason ?? 'no macOS VM can be started'}`;
}
