import { ChildProcess } from 'child_process';
import { processStartTime, lookUpStartTime, mayEscalate, markerHolders, signalOrphanPids, parsePidRecord } from './runner-cleanup';
import { GRACE_MS } from './process-group';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { StringDecoder } from 'string_decoder';
import * as yaml from 'js-yaml';
import type { DockerPolicy } from '../shared/docker-policy';
import { DockerBackend, noDockerBackend } from './docker/docker-backend';
import { DockerFilterProxy } from './docker/docker-filter-proxy';
import {
  SandboxPolicyLevel, RunnerState, RunnerStatus, LogEntry, RunnerConfig, JobHistoryEntry, JobStatus, LOG_LEVEL_PRIORITY, LogLevel, UserFilterConfig, SANDBOX_POLICY_LEVEL_DESCRIPTIONS } from '../shared/types';
import { DEFAULT_RUNNER_COUNT, DEFAULT_MAX_JOB_HISTORY, MIN_RUNNER_COUNT, MAX_RUNNER_COUNT } from '../shared/constants';
import { SandboxFilesystemPolicy, spawnSandboxed } from './process-sandbox';
import { inheritedWorkerEnv, javaToolOptions, levelToolchainPaths, packageCacheEnv } from './worker-env';
import { DEFAULT_BROKER_PORT, developerCredentialPaths, type EnvPolicy, type ProcessMarker } from '../shared/sandbox-profile';
import { developerPython, reapMarkedProcessesAsync } from '../shared/sandbox-reaper';
import { groupHasMembers, sweepInGrace, sweepProcessGroup } from './process-group';
import { ProxyServer, ProxyLogEntry } from './proxy-server';
import { GitHubClientError } from './github-client';
import { RunnerDownloader } from './runner-downloader';
import { dockerCliPath, helperPath, DOCKER_CONFIG_DIR_NAME, SHARE_DIR_NAME } from './vm/paths';
import type { WorkerCredentialFiles } from './worker-credentials';
import type { BrokerJobTarget } from './broker-proxy-service';
import { getAppDataDir, getConfigPath, getJobHistoryPath, getRunnerDir, getUserDataDir } from './paths';
import {
  loadConfig,
  resolveDockerVmConfig,
  resolveJobEnvironmentConfig,
  type DockerVmConfig,
  type JobEnvironmentConfig,
} from './config';
import { createMissingGrantedDirs, gitSshCommand, JOB_HOME_DIR_NAME, prepareJobHome } from '../shared/job-home';
import type { IsolationType } from '../shared/isolation';
import { createJobTempDir, jobTempName, removeJobTempDir, userTempDir } from './job-temp';
import { writeJobBin } from './job-shims';
import { normalizeFilterConfig, isUserAllowed, areAllUsersAllowed, parseRepository } from './runner/user-filter';

/**
 * The filtering docker socket a worker gets, at the root of its sandbox
 * directory. Short and fixed: macOS caps unix socket paths at 104 bytes and
 * truncates silently past that.
 */
const DOCKER_SOCKET_NAME = 'docker.sock';

/** macOS's default PATH, for a job whose app was started with none. */
const DEFAULT_SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * The longest line of worker output that is read as a line, in characters
 * (UTF-16 code units, as string length counts them). The runner's own status
 * lines are far shorter; anything longer is a job's output.
 */
const MAX_OUTPUT_LINE = 64 * 1024;

/** The name recorded for a job whose start line was over MAX_OUTPUT_LINE. */
const OVERLONG_JOB_NAME = '(job name too long to read)';

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
 * Split a worker's output stream into whole lines.
 *
 * A pipe hands over whatever was written, cut anywhere: a runner line can
 * arrive in two chunks, and splitting each chunk on its own read both halves
 * as lines - the real one missed, and the tail of a line a job printed read
 * as though it began a line. So the unfinished line is carried to the next
 * chunk (and read at end of stream), and bytes are decoded across chunks.
 * A line is given up as soon as it passes MAX_OUTPUT_LINE, and skipped to
 * its end, rather than buffered without bound: a job that never prints a
 * newline must not grow this process. onSkipped hears of each one once.
 */
export function lineReader(
  onLine: (line: string) => void,
  onSkipped: () => void
): { write(chunk: Buffer | string): void; end(): void } {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  /** Inside a line already given up, up to its newline. */
  let skipping = false;
  const feed = (text: string): void => {
    let start = 0;
    for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
      const piece = text.slice(start, nl);
      start = nl + 1;
      if (skipping) {
        skipping = false;
        continue;
      }
      const line = pending + piece;
      pending = '';
      if (line.length > MAX_OUTPUT_LINE) onSkipped();
      else if (line) onLine(line);
    }
    if (skipping) return;
    pending += text.slice(start);
    if (pending.length > MAX_OUTPUT_LINE) {
      skipping = true;
      pending = '';
      onSkipped();
    }
  };
  return {
    write: (chunk) => feed(typeof chunk === 'string' ? chunk : decoder.write(chunk)),
    // The last line may have no newline; the stream's end finishes it.
    end: () => feed(`${decoder.end()}\n`),
  };
}

/**
 * Get the hostname without .local suffix (common on macOS).
 */
function getCleanHostname(): string {
  return os.hostname().replace(/\.local$/, '');
}

interface RunnerInstance {
  /**
   * Hash of the approved policy this worker's sandbox profile was built from.
   * The profile is fixed at spawn, so a worker whose stamp no longer matches
   * the approved policy must not serve a job under it.
   */
  policyStamp?: string;
  /** This spawn's marker file, held open by the worker's tree; see createMarker. */
  markerPath?: string;
  /**
   * This spawn's own sandbox directory, which its profile grants and its
   * docker socket lives in. No other spawn is ever built there; removed once
   * nothing of its job is left running (see sweepFinishedSpawn).
   */
  sandboxDir?: string;
  /** The process group this spawn's worker leads, kept after its handle is cleared. */
  groupId?: number;
  /**
   * The tripwire this spawn's sandbox holds in `_work/.localmost-share`,
   * written before the worker starts: its Docker VM must read it back.
   */
  shareNonce?: string;
  /** The mark this spawn's profile carries; see createProcessMarker. */
  processMarker?: ProcessMarker;
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

/** What a finished spawn leaves behind, swept once its exit sweep has run. */
interface FinishedSpawn {
  markerPath?: string;
  processMarker?: ProcessMarker;
  sandboxDir?: string;
  groupId?: number;
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
  /** The level the policy asks for; strict when it declares none. */
  level: SandboxPolicyLevel;
  /** Paths the policy declares readable, applied when the worker is spawned. */
  readPaths: string[];
  /** Paths the policy declares writable, applied when the worker is spawned. */
  writePaths: string[];
  /** The docker actions the policy declares, merged across shared and workflow; empty when it declares none. */
  docker: DockerPolicy;
  /**
   * Which of the app's own environment variables a worker may inherit beyond
   * the baseline, and which it may not; applied when the worker is spawned.
   * Absent means the policy declares none.
   */
  env?: EnvPolicy;
  /** Hosts the policy denies, resolved per workflow like hosts; absent means none. */
  deniedHosts?: string[];
  /** Paths the policy denies, applied when the worker is spawned; absent means none. */
  denyPaths?: string[];
  /**
   * Loopback the policy opens beyond the worker's own proxy: every port, or
   * these ones. Applied to the profile at spawn and to the proxy per job;
   * absent means none.
   */
  loopback?: true | number[];
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
  /** The jobEnvironment settings: which conveniences a job's environment gets. Read at each spawn. */
  getJobEnvironmentConfig?: () => JobEnvironmentConfig;
  /**
   * The per-user temp directory, `/var/folders/<a>/<b>/T`, where each job
   * gets a directory of its own. userTempDir() by default.
   */
  getUserTempDir?: () => string | undefined;
  /** The bundled docker CLI, linked in the job's bin directory, first on its PATH. dockerCliPath() by default. */
  dockerCli?: string;
  /** The Docker VM helper, which the job's profile refuses to run. helperPath() by default. */
  vmHelper?: string;
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
  private readonly getJobEnvironmentConfig: () => JobEnvironmentConfig;
  private readonly getUserTempDir: () => string | undefined;
  private readonly dockerCli: string;
  private readonly vmHelper: string;

  // Flag to track intentional stops vs job completion restarts
  private stopping = false;

  // Runner downloader for directory management
  private readonly downloader: RunnerDownloader;

  // Config path for localmost settings
  private readonly configPath: string;

  // Current runner version
  private runnerVersion: string | null = null;

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
  /**
   * The process group each slot's last worker led, once a sweep of it has
   * had something to signal. See slotDraining.
   */
  private drainingGroups: Map<number, number> = new Map();

  // Path to job history file
  private readonly jobHistoryPath: string;

  // Pending target context for jobs received from broker
  // Keyed by slot number, or 'next' for the job admission is handing to spawnWorkerForJob
  // githubRepo is owner/repo as GitHub reports it: the name the policy was
  // approved and checked under, which for an organization target the display
  // name is not. isolation is the type admission chose for the job, set by
  // spawnWorkerForJob on the slot's context.
  private pendingTargetContext: Map<string, { targetId: string; targetDisplayName: string; actionsUrl?: string; githubRunId?: number; githubJobId?: number; githubActor?: string; githubSha?: string; githubRef?: string; githubWorkflow?: string; jobId?: string; githubRepo?: string; isolation?: IsolationType }> = new Map();

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
    this.getJobEnvironmentConfig = options.getJobEnvironmentConfig ?? (() => resolveJobEnvironmentConfig(undefined));
    this.getUserTempDir = options.getUserTempDir ?? (() => userTempDir((_level, message) => this.log('error', message)));
    this.dockerCli = options.dockerCli ?? dockerCliPath();
    this.vmHelper = options.vmHelper ?? helperPath();

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
      // Consider running if process is active OR status indicates active state
      if (instance.process || instance.status === 'starting' || instance.status === 'listening' || instance.status === 'busy') {
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

  getToolCacheLocation(): 'persistent' | 'per-sandbox' {
    return this.toolCacheLocation;
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

    // Kill any stale runner processes
    await this.killStaleProcesses();
    await this.detectStaleRunnerProcesses();

    const displayName = this.getStatusDisplayName();
    this.log('info', `Runner manager initialized (max ${this.runnerCount}, ${displayName})`);

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
      if (this.slotIsFree(i)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether a slot can be given to a new worker: nothing is running in it,
   * whatever its status says, and nothing its last worker left is still
   * waiting out a grace period.
   *
   * A status of 'error' is not an exit. A worker whose status went to error
   * while it runs keeps its job, sandbox, proxy and broker key; a second one
   * started in its slot would share the slot's proxy and key with it, and
   * leave the first one's exit to find the slot taken and skip its sweep.
   */
  private slotIsFree(instanceNum: number): boolean {
    if (this.slotDraining(instanceNum)) return false;
    const instance = this.instances.get(instanceNum);
    if (!instance) return true;
    return (instance.status === 'offline' || instance.status === 'error') && !instance.process;
  }

  /**
   * Whether the process group a slot's last worker led was sent SIGTERM and
   * still has members, and has not yet been sent SIGKILL. What is left there
   * belongs to the last job and runs under its profile; the slot waits,
   * a grace period at most, rather than start another job beside it.
   */
  private slotDraining(instanceNum: number): boolean {
    const group = this.drainingGroups.get(instanceNum);
    if (group === undefined) return false;
    if (sweepInGrace(group) && groupHasMembers(group)) return true;
    this.drainingGroups.delete(instanceNum);
    return false;
  }

  /** Sweep a finished worker's process group, and hold its slot while the sweep is in its grace period. */
  private sweepWorkerGroup(instanceNum: number, workerPid: number | undefined): void {
    const signalled = sweepProcessGroup(workerPid, {
      onLog: (message) => this.log('warn', `[instance ${instanceNum}] ${message}`),
    });
    if (signalled && workerPid) this.drainingGroups.set(instanceNum, workerPid);
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
  async spawnWorkerForJob(isolation: IsolationType): Promise<boolean> {
    // Take the context before waiting for a slot. 'next' is a single shared
    // slot, so a job arriving during the wait would otherwise overwrite it and
    // this worker would start with another repository's context.
    const claimedContext = this.pendingTargetContext.get('next');
    if (claimedContext) {
      this.pendingTargetContext.delete('next');
    }

    // The isolation admission chose. Seatbelt is the only type with an
    // implementation: the worker below runs under sandbox-exec. The service
    // account and the macOS VM each start their worker their own way, and
    // until they do, a job chosen for one is not run - never under seatbelt
    // instead, which its repository may not have listed. A type added to
    // ISOLATION_TYPES without a case here fails to compile, and one that
    // arrives anyway is not run either.
    switch (isolation) {
      case 'seatbelt':
        break;
      case 'service-account':
      case 'macos-vm':
        this.log('error', `${isolation} isolation has no implementation in this build; this job will not run`);
        return false;
      default: {
        const unknown: never = isolation;
        this.log('error', `unknown isolation type ${JSON.stringify(unknown)}; this job will not run`);
        return false;
      }
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
    // before the runner starts, and the job start reads it from here; with
    // the isolation it runs under.
    this.pendingTargetContext.set(String(instanceNum), { ...targetContext, isolation });

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
      // returning. A worker with no process never started.
      if (!this.instances.get(instanceNum)?.process) {
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
      // Per-worker secret. Every worker's proxy is on loopback, which a job
      // whose policy opens loopback can reach, so without this a job could
      // route its traffic through another worker's proxy and take that
      // repository's allowlist. The token rides in the proxy URL this worker
      // is given.
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
    if (this.instances.get(instanceNum)?.process) {
      this.log('warn', `Instance ${instanceNum} still has a worker running; not starting another in its slot`);
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
      this.discardSandbox(instanceNum, instance);
      this.updateAggregateStatus();
      this.startingInstances.delete(instanceNum);
      return;
    }

    const runnerBinary = path.join(sandboxDir, 'run.sh');

    if (!fs.existsSync(runnerBinary)) {
      this.log('warn', `Runner binary not found for instance ${instanceNum}, skipping`);
      instance.status = 'error';
      this.discardSandbox(instanceNum, instance);
      this.updateAggregateStatus();
      this.startingInstances.delete(instanceNum);
      return;
    }

    // Verify config is in sandbox
    const runnerConfigFile = path.join(sandboxDir, '.runner');
    if (!fs.existsSync(runnerConfigFile)) {
      this.log('warn', `Runner instance ${instanceNum} not configured, skipping`);
      instance.status = 'error';
      this.discardSandbox(instanceNum, instance);
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
        this.discardSandbox(instanceNum, instance);
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

      // Install the policy before the runner process exists. A reused proxy
      // still holds the last job's hosts until this runs.
      this.closeProxyPolicy(proxy);
      // Rotate the proxy token every start (finalizeInstance rotates at exit
      // too). The proxy is reused across a slot's jobs, so without this a
      // detached orphan of the previous job would keep a valid HTTP_PROXY
      // credential and could reach this job's allowlist through the same
      // proxy after its policy is replaced.
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
      // the filesystem boundary and the environment can come from that
      // repository's approved policy. Both are fixed at spawn, which is why a
      // policy change must retire the workers built under the old one.
      const startupContextForPolicy = this.pendingTargetContext.get(String(instanceNum));
      const filesystemPolicy = await this.resolveFilesystemPolicy(startupContextForPolicy);

      const proxyUrl = proxy.getProxyUrl();
      // Not the app's whole environment: launched from a shell, it carries
      // every token and agent socket that shell had. A worker inherits the
      // baseline a runner and a shell need, plus what the repository's env
      // policy allows; everything set below is the app's and comes after, so
      // no policy can replace it.
      const env: NodeJS.ProcessEnv = {
        ...inheritedWorkerEnv(process.env, filesystemPolicy.env),
        ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT: 'true',
      };

      // Set tool cache location based on setting
      // 'persistent' = the worker's target's own directory, kept across that
      //   target's jobs (fast subsequent jobs). Never shared between targets:
      //   setup-* actions execute what they find there, so a shared cache let
      //   one repository's job plant a toolchain another's would run.
      // 'per-sandbox' = inside sandbox, rebuilt each time (clean but slow).
      // A worker with no target gets none, and so no shared path either. The
      // target is the one the policy above was resolved for, so the caches
      // and the policy they are granted under always belong together.
      const cacheTargetId = startupContextForPolicy?.targetId;
      let toolCacheDir: string | undefined;
      if (this.toolCacheLocation === 'persistent' && cacheTargetId) {
        try {
          toolCacheDir = this.downloader.getToolCacheDir(cacheTargetId);
          fs.mkdirSync(toolCacheDir, { recursive: true, mode: 0o700 });
          env.RUNNER_TOOL_CACHE = toolCacheDir;
          env.AGENT_TOOLSDIRECTORY = toolCacheDir; // Some actions check this instead
        } catch (err) {
          this.log('warn', `No tool cache for instance ${instanceNum}; its tools stay in the job: ${(err as Error).message}`);
          toolCacheDir = undefined;
        }
      }

      // The sandbox confines the runner to this proxy, and that rule only
      // matches when the kernel can attribute the connection to loopback. A
      // dual-stack socket connecting to an IPv4-mapped address is reported
      // with no host at all, so the connection is denied; IPv4-only keeps it
      // attributable.
      env.DOTNET_SYSTEM_NET_DISABLEIPV6 = '1';

      env.http_proxy = proxyUrl;
      env.https_proxy = proxyUrl;
      env.HTTP_PROXY = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;

      // Under moderate and permissive the job's package managers get a
      // directory of their own, in place of the write access to the user's
      // ~/.cargo, ~/go, ~/.gradle and the like those levels used to grant -
      // trees that hold the user's PATH directories and tool config. Strict
      // keeps exactly what the repository declares.
      // Kept across jobs only where the tool cache is: the package cache holds
      // what the target's next job executes (gradle init scripts, cargo's
      // config and bin, GOPATH/bin), so with per-sandbox selected, or no
      // target, it lives in the job's own sandbox and goes with it.
      let packageCacheDir: string | undefined;
      if (filesystemPolicy.level !== 'strict') {
        if (this.toolCacheLocation === 'persistent' && cacheTargetId) {
          try {
            packageCacheDir = path.join(this.downloader.getTargetCacheDir(cacheTargetId), 'packages');
            fs.mkdirSync(packageCacheDir, { recursive: true, mode: 0o700 });
          } catch (err) {
            this.log('warn', `No package cache for instance ${instanceNum}; its packages stay in the job: ${(err as Error).message}`);
            packageCacheDir = undefined;
          }
        }
        // The sandbox directory is already writable, and a new one for each start,
        // so this needs no grant of its own.
        Object.assign(env, packageCacheEnv(packageCacheDir ?? path.join(sandboxDir, '_packages')));
      }

      // The job's docker socket is one localmost serves, not the daemon's.
      // It lives in this spawn's own sandbox directory, so its path is new
      // with every job - an earlier job's leftover, whose profile granted the
      // earlier path, cannot connect to it - and it goes with the sandbox.
      const dockerSocketPath = path.join(sandboxDir, DOCKER_SOCKET_NAME);
      const dockerSocket = await this.startDockerProxy(instanceNum, dockerSocketPath, sandboxDir, shareNonce);
      // The last wait before the spawn. A stop() in the meantime finalized
      // this instance and took its sandbox to be swept, as a finished
      // spawn's; a worker started there now would lose it as it runs.
      if (instance.policySealed) {
        throw new Error('its slot was let go while it started');
      }
      env.DOCKER_HOST = `unix://${dockerSocketPath}`;
      // Pin the job to the classic builder. BuildKit - the default since
      // Docker 23 - does not use POST /build at all: it negotiates a session
      // and streams the build over gRPC, exporting host filesystem access to
      // the daemon as it goes. "Which paths may this build read" then stops
      // being a property of any request the filter can see, so `build:` policy
      // would describe an endpoint a real `docker build` never calls.
      env.DOCKER_BUILDKIT = '0';
      // The bundled CLI, reading an empty config of the job's own rather
      // than the operator's ~/.docker.
      env.DOCKER_CONFIG = path.join(sandboxDir, DOCKER_CONFIG_DIR_NAME);
      // First on PATH, the job's own bin directory: the bundled CLI, linked,
      // and the swift and xcodebuild shims that turn SwiftPM's and Xcode's
      // own sandbox off, which macOS refuses to nest inside the job's (see
      // job-shims.ts). Should it not be made, the CLI's own directory, as
      // before. With no PATH of its own, the job still gets the system's
      // after it.
      const jobEnvironment = this.getJobEnvironmentConfig();
      let binDir: string;
      try {
        binDir = writeJobBin(sandboxDir, { dockerCli: this.dockerCli, shims: jobEnvironment.toolShims });
      } catch (err) {
        this.log('warn', `No bin directory of its own for instance ${instanceNum}; its job has no swift or xcodebuild shims: ${(err as Error).message}`);
        binDir = path.dirname(this.dockerCli);
      }
      env.PATH = `${binDir}:${env.PATH || DEFAULT_SYSTEM_PATH}`;

      // A home of the job's own: HOME is <sandbox>/home, empty, the job's to
      // write and gone with the sandbox, so tools look for their dotfiles
      // there rather than in the user's home, where the sandbox denies most
      // of what they would find - a regular ~/.gitconfig, which checkout
      // copies from $HOME, made it fail at every level. What the approved
      // policy and the level grant under the real home is linked in at the
      // same path, so a tool finds it through HOME; the sandbox judges the
      // path a link resolves to, so the link reaches no more than the grant.
      const jobHome = path.join(sandboxDir, JOB_HOME_DIR_NAME);
      const homeLog = (level: 'debug' | 'warn', message: string) => this.log(level, `[sandbox ${instanceNum}] ${message}`);
      if (jobEnvironment.createMissingGrantedDirs) {
        // A granted directory that does not exist yet, which a job that is
        // denied its parent could not create for itself.
        try {
          const credentialPaths = developerCredentialPaths();
          const created = createMissingGrantedDirs(filesystemPolicy.write, {
            excludeRoots: [getAppDataDir(), getUserDataDir()],
            deniedRoots: [...credentialPaths.subpaths, ...credentialPaths.literals],
            log: homeLog,
          });
          if (created.length > 0) this.log('info', `Created ${created.join(', ')}, granted to the job of instance ${instanceNum}`);
        } catch (err) {
          this.log('warn', `Could not create the directories granted to instance ${instanceNum}: ${(err as Error).message}`);
        }
      }
      env.HOME = jobHome;
      // Git made hermetic and able to authenticate to this worker's proxy:
      // the job's $HOME/.gitconfig is the per-job global config, nothing of
      // the user's (see JOB_GIT_CONFIG), and the system config is skipped.
      try {
        const { gitConfig, linked } = prepareJobHome(jobHome, {
          grants: [...filesystemPolicy.read, ...filesystemPolicy.write, ...levelToolchainPaths(filesystemPolicy.level)],
          log: homeLog,
        });
        env.GIT_CONFIG_GLOBAL = gitConfig;
        if (linked.length > 0) this.log('debug', `[sandbox ${instanceNum}] Linked into the job's home: ${linked.join(', ')}`);
      } catch (err) {
        this.log('warn', `Could not prepare the home of instance ${instanceNum}; its job runs with an empty one: ${(err as Error).message}`);
        env.GIT_CONFIG_GLOBAL = '/dev/null';
      }
      env.GIT_CONFIG_SYSTEM = '/dev/null';
      env.GIT_CONFIG_NOSYSTEM = '1';
      // ssh finds its directory through the user database, not HOME, so git's
      // ssh is pointed at the job's home explicitly.
      env.GIT_SSH_COMMAND = gitSshCommand(jobHome);

      // Keep the job's temp inside its own sandbox. The default $TMPDIR is a
      // per-user directory shared with every other process the user runs, and
      // the sandbox can no longer reach unix sockets there - so a build tool
      // or test suite that puts a socket under TMPDIR must find TMPDIR in a
      // place it is allowed to use. The sandbox directory is that place.
      const jobTmp = path.join(sandboxDir, '_temp');
      try {
        fs.mkdirSync(jobTmp, { recursive: true });
      } catch (err) {
        this.log('warn', `Could not create job temp dir for instance ${instanceNum}: ${(err as Error).message}`);
      }
      env.TMPDIR = jobTmp;
      env.TMP = jobTmp;
      env.TEMP = jobTmp;
      env.RUNNER_TEMP = jobTmp;
      // Some tools ignore TMPDIR and keep state in the per-user temp and cache
      // directories, which the sandbox does not grant: those are shared with
      // everything the user runs, and the xcrun cache and clang module cache
      // there are trusted by the user's own compilers. Each of these has a
      // variable that moves it into the job's temp. xcrun cannot resolve a
      // tool at all without a cache it can write; zsh puts here-documents
      // under /tmp.
      env.xcrun_db = path.join(jobTmp, 'xcrun_db');
      env.CLANG_MODULE_CACHE_PATH = path.join(jobTmp, 'clang-module-cache');
      env.TMPPREFIX = path.join(jobTmp, 'zsh');
      // Foundation ignores TMPDIR: NSTemporaryDirectory(), java.io.tmpdir and
      // the staging directory of a sandboxed process's atomic writes - which
      // SwiftPM and xcodebuild make all the time - are in the per-user temp
      // directory. DIRHELPER_USER_DIR_SUFFIX moves them into a directory of
      // the job's own there, made now, granted by its profile, and removed
      // with its sandbox (see job-temp.ts).
      let tempSuffixDir: string | undefined;
      if (jobEnvironment.perJobTempDir) {
        const userTemp = this.getUserTempDir();
        if (userTemp) {
          try {
            tempSuffixDir = createJobTempDir(userTemp, sandboxDir);
            env.DIRHELPER_USER_DIR_SUFFIX = path.basename(tempSuffixDir);
          } catch (err) {
            this.log('warn', `No temp directory of its own for instance ${instanceNum}; Foundation's atomic writes will fail in its job: ${(err as Error).message}`);
          }
        }
      }
      // The JVM reads neither TMPDIR, HOME nor HTTPS_PROXY, and its
      // dual-stack sockets reach loopback in a way the sandbox cannot
      // attribute: its temp, home, IPv4 and the proxy are set where every
      // JVM picks them up (see javaToolOptions). A workflow's own
      // JAVA_TOOL_OPTIONS replaces it.
      if (jobEnvironment.javaToolOptions) {
        env.JAVA_TOOL_OPTIONS = javaToolOptions({ tmpDir: jobTmp, home: jobHome, proxyUrl });
      }

      // A per-spawn marker file, held open by the worker and by what it starts
      // through its bash and .NET layers (run.sh, Listener, Worker, `run:` step
      // shells and what they exec): those inherit the descriptor and keep it
      // for as long as they live, even after the worker leader has exited. A
      // later sweep can then find exactly this spawn's survivors with lsof -
      // something a pid or pgid cannot do safely once the leader is gone, since
      // either may have been reused. Passed as fd 3; the runner never touches
      // it. Not inherited by children that Node or Python spawn (both close
      // inherited fds), so those are reached only via the process group while
      // the leader lives - see markerHolders.
      let markerPath: string | undefined;
      let markerFd: number | undefined;
      try {
        markerPath = this.createMarker(instanceNum);
        instance.markerPath = markerPath;
        markerFd = fs.openSync(markerPath, 'r');
      } catch (err) {
        // Bookkeeping, not a prerequisite: without a marker this spawn's
        // stragglers are reachable only through its process group, as before.
        this.log('warn', `Could not create marker for instance ${instanceNum}: ${(err as Error).message}`);
      }

      // The spawn's mark in its profile, which no process of the job can
      // shed: every process the worker starts runs under that profile and
      // cannot leave it, so the mark finds them all once the spawn is done -
      // one that left the process group with setsid() and closed the marker
      // descriptor included.
      let processMarker: ProcessMarker | undefined;
      try {
        processMarker = this.createProcessMarker(instanceNum, markerPath);
        instance.processMarker = processMarker;
      } catch (err) {
        this.log('warn', `Could not mark instance ${instanceNum}'s profile; what its job leaves outside its process group will not be found: ${(err as Error).message}`);
      }

      try {
        instance.process = spawnSandboxed(runnerBinary, ['--once'], {
          cwd: sandboxDir,
          env,
          stdio: markerFd !== undefined ? ['ignore', 'pipe', 'pipe', markerFd] : ['ignore', 'pipe', 'pipe'],
          // Create a new process group so we can kill all child processes
          detached: true,
          filesystemPolicy,
          // The loopback ports the profile always opens: the worker's own
          // proxy, and the broker, which the runner dials directly.
          proxyPort: proxy.getPort(),
          brokerPort: this.brokerPort(),
          dockerSocket: dockerSocketPath,
          // The Docker VM's share: the job keeps its contents, not the node.
          shareDir: path.join(sandboxDir, SHARE_DIR_NAME),
          dockerCli: this.dockerCli,
          // It carries the virtualization entitlement; only the app runs it.
          vmHelper: this.vmHelper,
          toolCacheDir,
          packageCacheDir,
          tempSuffixDir,
          // T/TemporaryDirectory.XXXXXX for Swift Build's link step, only
          // when Settings turns it on: see JobEnvironmentConfig.
          swiftBuildLinkTemp: jobEnvironment.swiftBuildLinkTemp,
          processMarker,
        });
      } finally {
        // The child holds its own copy; this process must not, or lsof would
        // list the app itself as a member of every worker's tree.
        if (markerFd !== undefined) {
          try { fs.closeSync(markerFd); } catch { /* already closed */ }
        }
      }
      instance.policyStamp = filesystemPolicy.stamp;
      // Spawned detached, so the worker leads its own group, by its pid.
      instance.groupId = instance.process.pid;

      // Don't set 'listening' until we see "Listening for Jobs". Until then
      // the instance stays 'starting', which keeps its slot from being
      // reserved for another job.

      // Write the PID for orphan detection into a directory only the app can
      // write. In the sandbox it was steerable: a job could drop any pid into
      // its own runner.pid and have the startup sweep SIGKILL it.
      if (instance.process.pid) {
        try {
          const pidDir = this.pidDir();
          fs.mkdirSync(pidDir, { recursive: true });
          // Line one "<pid> <start time>": the start time lets a later sweep
          // tell this worker from a stranger that inherited its pid after a
          // crash. Line two: the spawn's marker file, which names the tree's
          // survivors even once the leader is gone.
          const started = processStartTime(instance.process.pid);
          const first = started ? `${instance.process.pid} ${started}` : instance.process.pid.toString();
          fs.writeFileSync(path.join(pidDir, `${instanceNum}.pid`), markerPath ? `${first}\n${markerPath}\n` : `${first}\n`);
        } catch (err) {
          this.log('warn', `Could not write pid file for instance ${instanceNum}: ${(err as Error).message}`);
        }
      }

      // Parsed only while this is the slot's worker. A pipe's last data and
      // its end can come after the exit, when a new spawn may hold the slot;
      // parseRunnerOutput reads the slot, and a dead worker's line read there
      // could start a job on the new one. Still logged.
      const worker = instance.process;
      const isCurrent = () => this.instances.get(instanceNum) === instance && instance.process === worker;
      // One reader per stream: a line is only ever continued on its own stream.
      const skipped = (stream: string) => () =>
        this.logInstanceOutput(instanceNum, 'debug', `(${stream}: skipped a line over ${MAX_OUTPUT_LINE} characters)`);
      const stdout = lineReader((line) => {
        if (isCurrent()) this.parseRunnerOutput(instanceNum, line);
        this.logInstanceOutput(instanceNum, 'debug', line);
      }, () => {
        // The runner never writes a line this long, so one skipped on stdout -
        // where it writes a job's start - before the worker has its job is
        // that job's start, with a name too long to read. Taken as anything
        // else, the start went unread and the next line - the tail of the
        // name, after a \n in it - was read as the runner's status.
        if (isCurrent() && !instance.tookJob) this.recordJobStart(instanceNum, OVERLONG_JOB_NAME);
        skipped('stdout')();
      });
      instance.process.stdout?.on('data', (data: Buffer) => stdout.write(data));
      instance.process.stdout?.on('end', () => stdout.end());

      const stderr = lineReader((line) => {
        if (isCurrent()) this.parseRunnerOutput(instanceNum, line); // Also parse stderr for status
        this.logInstanceOutput(instanceNum, 'error', line);
      }, skipped('stderr'));
      instance.process.stderr?.on('data', (data: Buffer) => stderr.write(data));
      instance.process.stderr?.on('end', () => stderr.end());

      instance.process.on('error', (error) => {
        this.log('error', `Runner instance ${instanceNum} error: ${error.message}`);
        instance.status = 'error';
        this.updateStatus('error', error.message);
        // A spawn that failed - EAGAIN with the process table full, EACCES -
        // leaves a child with no pid that emits 'error' and never 'exit'.
        // Nothing ran: discard the start and end it as an exit would, or the
        // slot keeps a worker that does not exist, and takes no job again.
        if (worker.pid === undefined && instance.process === worker) {
          this.discardUnstartedSpawn(instanceNum, instance);
          onExit(null, null);
        }
      });

      let exited = false;
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (exited) return;
        exited = true;
        // Captured before the handle is cleared. A worker runs with --once, so
        // by the time it exits its job is over and nothing of that job should
        // still be running - but a cancelled job left its step's own process
        // alive, reparented to launchd where nothing would reap it, burning two
        // cores and writing to a full disk for over an hour after GitHub had
        // marked the job cancelled. Swept here rather than in one of the
        // branches below, because every one of them is a path where the job has
        // ended.
        const workerPid = instance.process?.pid;
        instance.process = null;

        // Only while this is still the slot's worker: a reaped or completed
        // worker's exit can land after the next worker was spawned into the
        // slot, and by then the OS may have reused this pid as the replacement's
        // group leader - sweeping -pid would kill the new worker. Everything
        // that acts on the pid or the slot happens under this guard.
        if (this.instances.get(instanceNum) === instance) {
          // Reap the job's own descendants. A cancelled step can outlive the
          // worker, reparented, burning CPU; the group sweep in process-group
          // probes and signals the group, not just the leader.
          this.sweepWorkerGroup(instanceNum, workerPid);
          // A job still current here is over, and this is where it is
          // closed: a completion line does not close it, being one the job
          // can write itself, and one can go unread besides - split by a \n
          // in the name, skipped as too long, or never written by a worker
          // that died mid-job. Left open, its history read 'running', with
          // Cancel offered, until the app next started.
          if (instance.currentJob) {
            const job = instance.currentJob;
            this.logSandboxSummary(instanceNum, job.name);
            this.closeJobOnExit(instanceNum, job, code, signal).catch((err) => {
              this.log('debug', `Closing job ${job.id} on exit failed: ${(err as Error).message}`);
            });
          }
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

        // A reaped worker handles SIGTERM gracefully and reports code 0 -
        // after the reap freed its slot, and possibly after a job refilled it.
        // Freeing the slot again would drop the replacement and seal its proxy.
        if (this.instances.get(instanceNum) !== instance) return;

        instance.jobsCompleted++;
        this.log('info', `Runner instance ${instanceNum} completed job #${instance.jobsCompleted}`);
        this.releaseInstanceSlot(instanceNum);
      };
      instance.process.on('exit', onExit);

      this.instances.set(instanceNum, instance);
      // Spawned for a specific job: if the broker never routes that job here,
      // this worker will long-poll forever and hold its slot. Give it a
      // deadline. One started with no pending target gets one too: only the
      // worker spawned for a job may take it, so that one never gets a job,
      // and without a deadline it held the slot until the app restarted.
      this.armAcquireDeadline(instanceNum);
      // Successfully started - clear the starting flag
      this.startingInstances.delete(instanceNum);
    } catch (error) {
      this.log('error', `Failed to start runner instance ${instanceNum}: ${(error as Error).message}`);
      instance.status = 'error';
      this.instances.set(instanceNum, instance);
      this.startingInstances.delete(instanceNum);
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
      if (!instance.process) this.discardUnstartedSpawn(instanceNum, instance);
    }
  }

  /**
   * Nothing started, so nothing holds the marker or the profile mark, or uses
   * the sandbox; remove them now.
   */
  private discardUnstartedSpawn(instanceNum: number, instance: RunnerInstance): void {
    if (instance.markerPath) {
      try { fs.unlinkSync(instance.markerPath); } catch { /* already gone */ }
      instance.markerPath = undefined;
    }
    if (instance.processMarker) {
      for (const file of [instance.processMarker.granted, instance.processMarker.withheld]) {
        try { fs.unlinkSync(file); } catch { /* already gone */ }
      }
      instance.processMarker = undefined;
    }
    this.discardSandbox(instanceNum, instance);
  }

  /** Remove the sandbox of a start that never ran a worker in it. */
  private discardSandbox(instanceNum: number, instance: RunnerInstance): void {
    const sandboxDir = instance.sandboxDir;
    if (!sandboxDir) return;
    instance.sandboxDir = undefined;
    this.downloader.removeSandbox(sandboxDir).catch((err) =>
      this.log('warn', `Could not remove the sandbox of instance ${instanceNum}; the next startup will: ${(err as Error).message}`)
    );
    void this.removeJobTemp(sandboxDir);
  }

  /**
   * Remove a sandbox's job temp directory, if it has one: by name, derived
   * from the sandbox, and only that (see removeJobTempDir). One that cannot
   * be removed goes at the next startup.
   */
  private async removeJobTemp(sandboxDir: string): Promise<void> {
    const userTemp = this.getUserTempDir();
    if (!userTemp) return;
    let dir: string;
    try {
      dir = path.join(userTemp, jobTempName(sandboxDir));
    } catch {
      return;
    }
    try {
      await removeJobTempDir(userTemp, dir, path.dirname(sandboxDir));
    } catch (err) {
      this.log('warn', `Could not remove ${path.basename(dir)} from the per-user temp directory; the next startup will: ${(err as Error).message}`);
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

    // Each worker's docker socket dies with its process; this catches the
    // ones whose exit never reached us.
    await Promise.all([...this.dockerProxies.keys()].map((instanceNum) => this.stopDockerProxy(instanceNum)));

    for (const instanceNum of [...this.acquireDeadlines.keys()]) {
      this.disarmAcquireDeadline(instanceNum);
    }
    // Revoke keys and drop pid files before the map is cleared, or a late exit
    // event finds its instance already gone and skips this - leaving a stopped
    // worker's broker credential valid and its pid record stale.
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
    // The whole group, not just the leader. A --once listener that ignores or
    // is slow to handle SIGTERM leaves descendants behind, and the slot is
    // released immediately below, so nothing comes back to look for them - the
    // same leak that left a cancelled benchmark running for over an hour.
    // The slot is not given to another job while they wait out the grace.
    const workerPid = instance.process?.pid;
    instance.process?.kill('SIGTERM');
    this.sweepWorkerGroup(instanceNum, workerPid);
    this.abandonJobFor(instanceNum);
    // A --once worker that never acquired a job never exits, so the exit
    // handler's cleanup would not run; releaseInstanceSlot finalizes the
    // instance (key, pid file, marker) itself.
    this.releaseInstanceSlot(instanceNum);
  }

  /**
   * Release a slot's per-worker resources: its broker key and pid file, and
   * in time its marker and sandbox. Called whenever an instance is finished
   * with - a worker exit, a reap, or stop() clearing the pool - so a stopped
   * or gone worker never leaves a usable /w/ credential or a stale pid record
   * behind. `finished` is the instance when the slot no longer holds it.
   * Idempotent.
   */
  private finalizeInstance(instanceNum: number, finished?: RunnerInstance): void {
    this.revokeBrokerUrl?.(instanceNum);
    // The proxy is the other credential a finished worker leaves behind: its
    // token and the job's hosts would stay live until the slot is next
    // started, which may be never. Close the policy, drop every connection
    // and rotate now, so a survivor of this job has no network the moment
    // the job is over. startInstance rotates again for its own worker;
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
    const pidFile = path.join(this.pidDir(), `${instanceNum}.pid`);
    let markerPath = instance?.markerPath;
    if (!markerPath) {
      try {
        const recorded = parsePidRecord(fs.readFileSync(pidFile, 'utf-8')).markerPath;
        // The record is app-owned, but a marker is only ever one of ours.
        if (recorded && this.isMarkerPath(recorded)) markerPath = recorded;
      } catch {
        // No record, or no marker in it.
      }
    }
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // Already gone, or never written.
    }
    // Ownership ends here, whichever path got here first: the exit handler
    // and releaseInstanceSlot both finalize a clean exit, and a later sweep
    // must see this marker as a finished spawn's, not a running worker's.
    if (instance && markerPath && instance.markerPath === markerPath) instance.markerPath = undefined;
    const sandboxDir = instance?.sandboxDir;
    const processMarker = instance?.processMarker;
    if (instance) {
      instance.sandboxDir = undefined;
      instance.processMarker = undefined;
    }
    this.settleSpawn({ markerPath, processMarker, sandboxDir, groupId: instance?.groupId });
  }

  /**
   * How long after a worker is finalized before what it leaves is swept: past
   * the exit sweep's own SIGKILL, so what still holds its marker then has
   * left the process group.
   */
  private static readonly MARKER_SETTLE_MS = GRACE_MS + 2000;
  /** Spawns with a settle sweep pending, so a second finalize of the same exit does not arm another. */
  private readonly settlingSpawns = new Set<string>();

  /**
   * Sweep what a finished worker leaves once the exit sweep's escalation has
   * run. Unref'd: it must not keep the app alive; if the app quits first,
   * the marker and the sandbox survive to the startup sweep.
   */
  private settleSpawn(spawn: FinishedSpawn): void {
    const key = spawn.markerPath ?? spawn.processMarker?.granted ?? spawn.sandboxDir;
    if (!key || this.settlingSpawns.has(key)) return;
    this.settlingSpawns.add(key);
    const timer = setTimeout(() => {
      this.settlingSpawns.delete(key);
      this.sweepFinishedSpawn(spawn).catch((err) =>
        this.log('warn', `Sweep of a finished worker failed: ${(err as Error).message}`)
      );
    }, RunnerManager.MARKER_SETTLE_MS);
    timer.unref();
  }

  /**
   * First whatever still runs under the spawn's profile mark is killed:
   * after the exit sweep's SIGKILL, that is what left the process group. Then
   * whatever still holds its marker, signalled by exact pid - which the mark
   * has already reached when it could look, and covers when it could not.
   * Then its sandbox goes, once its process group is empty: a sandbox
   * something of the job still runs in is left to the startup sweep rather
   * than pulled out from under it. The group is asked by its leader's pid,
   * so a group that emptied and whose pid now leads another keeps the
   * sandbox until then too; that costs only disk.
   */
  private async sweepFinishedSpawn({ markerPath, processMarker, sandboxDir, groupId }: FinishedSpawn): Promise<void> {
    if (processMarker) {
      const killed = await reapMarkedProcessesAsync(processMarker);
      let keep = false;
      if (killed === null) {
        // Without the developer tools the startup sweep cannot look either;
        // kept, the mark would only pile up, two files for every job.
        keep = (await developerPython()) !== null;
        this.log('warn', keep
          ? `Could not look for what a finished job left outside its process group; ${path.basename(processMarker.granted)} is kept for the next startup's sweep`
          : 'Could not look for what a finished job left outside its process group: that needs the developer tools');
      } else if (killed.length > 0) {
        this.log('warn', `Killed ${killed.join(', ')}, left running outside its process group by a finished job`);
      }
      if (!keep) {
        for (const file of [processMarker.granted, processMarker.withheld]) {
          await fs.promises.unlink(file).catch(() => undefined);
        }
      }
    }
    if (markerPath) {
      try {
        const outcome = await this.sweepMarker(markerPath, 2000);
        if (outcome === 'kept') this.log('info', `${path.basename(markerPath)} kept for the next sweep`);
      } catch (err) {
        this.log('warn', `Sweep of ${path.basename(markerPath)} failed: ${(err as Error).message}`);
      }
    }
    if (!sandboxDir) return;
    if (groupId !== undefined && groupHasMembers(groupId)) {
      this.log('warn', `Process group ${groupId} is still running; its sandbox is left for the next startup to remove`);
      return;
    }
    try {
      await this.downloader.removeSandbox(sandboxDir);
    } catch (err) {
      this.log('warn', `Could not remove ${path.basename(sandboxDir)}; the next startup will: ${(err as Error).message}`);
    }
    await this.removeJobTemp(sandboxDir);
  }

  /** Pids of the workers this manager is running now. */
  private livePids(): Set<number> {
    const pids = new Set<number>();
    for (const instance of this.instances.values()) {
      if (instance.process?.pid) pids.add(instance.process.pid);
    }
    return pids;
  }

  /** Whether a worker this manager is running now owns the marker. */
  private ownsMarker(markerPath: string): boolean {
    for (const instance of this.instances.values()) {
      if (instance.process?.pid && instance.markerPath === markerPath) return true;
    }
    return false;
  }

  /** Whether a path is one of this manager's marker files, by location and name. */
  private isMarkerPath(p: string): boolean {
    return path.dirname(p) === this.pidDir() && /^\d+-[0-9a-f]+\.mark$/.test(path.basename(p));
  }

  /**
   * Reap whatever still holds a finished spawn's marker, then remove the
   * marker once nothing does. A marker a running worker owns, or whose
   * holders include a running worker, is left entirely alone - no signal, no
   * unlink: its holders are that job's Listener, Worker and steps, and the
   * marker is how a later sweep would find them if the app died. A marker
   * whose holders cannot be determined, or that is still held after the
   * escalation, is kept: it is the one reuse-proof handle a later sweep has
   * on those survivors.
   */
  private async sweepMarker(markerPath: string, graceMs: number): Promise<'released' | 'kept' | 'owned'> {
    if (this.ownsMarker(markerPath)) return 'owned';
    const holders = await markerHolders(markerPath, (m) => this.log('warn', m));
    if (holders === null) return 'kept';
    // Decided after the wait, not before it: a worker that spawned meanwhile
    // is live, and a pid it holds is not ours to signal.
    if (this.ownsMarker(markerPath) || holders.some((pid) => this.livePids().has(pid))) return 'owned';
    let remaining: number[] | null = holders;
    if (holders.length > 0) {
      const result = await signalOrphanPids(holders, (m) => this.log('info', m), graceMs, () => markerHolders(markerPath));
      remaining = result.remaining;
    }
    if (remaining !== null && remaining.length === 0) {
      await fs.promises.unlink(markerPath).catch(() => undefined);
      return 'released';
    }
    return 'kept';
  }

  /**
   * Create this spawn's marker file and return its path. Nothing else is
   * touched: the nonce makes each marker unique, and deletion belongs to
   * finalizeInstance (once nothing holds it) and to the startup sweeps, which
   * are the only ones that can tell a crash leftover with live survivors from
   * an empty file.
   */
  private createMarker(instanceNum: number): string {
    const pidDir = this.pidDir();
    fs.mkdirSync(pidDir, { recursive: true });
    const markerPath = path.join(pidDir, `${instanceNum}-${randomBytes(8).toString('hex')}.mark`);
    fs.writeFileSync(markerPath, '');
    return markerPath;
  }

  /**
   * Create the two files this spawn's profile reads one of and not the other
   * (processMarkerRules), named for its marker file when it has one. They sit
   * in the pid directory, which no job can write, and no other profile tells
   * them apart. Removed once the finished spawn has been swept by them; the
   * startup sweep takes any a crash or a failed sweep left.
   */
  private createProcessMarker(instanceNum: number, markerPath?: string): ProcessMarker {
    let pidDir = this.pidDir();
    fs.mkdirSync(pidDir, { recursive: true });
    // Seatbelt matches real paths, and the sweep asks about these.
    try {
      pidDir = fs.realpathSync(pidDir);
    } catch {
      // Kept as spelled.
    }
    const stem = markerPath ? path.basename(markerPath, '.mark') : `${instanceNum}-${randomBytes(8).toString('hex')}`;
    const marker = { granted: path.join(pidDir, `${stem}.granted`), withheld: path.join(pidDir, `${stem}.withheld`) };
    fs.writeFileSync(marker.granted, '', { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(marker.withheld, '', { mode: 0o600, flag: 'wx' });
    return marker;
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
    // revoke the broker key, drop the pid file, settle the marker and the
    // sandbox - or a finished worker's URL stays usable and its records
    // linger until the slot is reused. Idempotent with the exit handler's own
    // call.
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
    signal: NodeJS.Signals | null
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
   * Identity of the half of a policy that is baked into the sandbox profile.
   *
   * Hosts are deliberately excluded: they are resolved per workflow and
   * applied to the proxy on every job, so including them made a repository
   * with a per-workflow network section look like it had drifted and its jobs
   * were refused. Only what the profile fixed at spawn belongs here.
   */
  private stampFor(
    policy: Pick<RepoPolicyRuntime, 'level' | 'readPaths' | 'writePaths' | 'env' | 'denyPaths' | 'loopback'>
  ): string {
    // The env policy is fixed at spawn like the profile, so it is part of
    // what a worker was built under; so are the denied paths and the
    // loopback ports, which the profile holds too. The denied hosts are not:
    // like the allowed ones they are resolved per workflow and applied to
    // the proxy on every claim. Nor is docker, for the same reason: it merges
    // shared with the claimed workflow's section and the socket is bound to
    // it per claim. The spawn stamp is taken before the workflow is known, so
    // stamping it made every claim of a workflow with its own docker section
    // read as drift.
    const fixedAtSpawn: unknown[] = [
      policy.level,
      policy.readPaths,
      policy.writePaths,
      policy.env,
      policy.denyPaths ?? [],
      policy.loopback ?? null,
    ];
    return createHash('sha256')
      .update(JSON.stringify(fixedAtSpawn))
      .digest('hex');
  }

  /**
   * The filesystem boundary for a worker about to be spawned.
   *
   * Falls back to strict with nothing declared, which is what a repository
   * with no approved policy gets: the runner's own floor and nothing else.
   */
  /**
   * Retire the workers a repository's policy change has made stale.
   *
   * A worker's sandbox profile is fixed at spawn, so one built under the old
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

  private async resolveFilesystemPolicy(
    context?: { targetDisplayName: string; githubSha?: string; githubRepo?: string }
  ): Promise<SandboxFilesystemPolicy & { env?: EnvPolicy; stamp?: string }> {
    // No stamp rather than a sentinel: a sentinel is truthy, so it would fail
    // the drift check against every real hash and the worker would refuse
    // every job. The profile it got is the closed one, which is the safe
    // state to run under, so there is nothing to detect drift from.
    const closed = {
      level: 'strict' as SandboxPolicyLevel,
      read: [],
      write: [],
      stamp: undefined,
    };
    if (!context?.targetDisplayName || !context.githubSha || !this.getRepoPolicy) return closed;

    const repoInfo = parseRepository(this.policyRepository(context));
    if (!repoInfo) return closed;

    try {
      const policy = await this.getRepoPolicy(repoInfo.owner, repoInfo.repo, context.githubSha, '');
      return {
        level: policy.level,
        read: policy.readPaths,
        write: policy.writePaths,
        deny: policy.denyPaths ?? [],
        ...(policy.loopback !== undefined ? { loopback: policy.loopback } : {}),
        env: policy.env,
        stamp: this.stampFor(policy),
      };
    } catch {
      return closed;
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

    // The filesystem half of the policy is baked into the sandbox profile at
    // spawn and cannot be changed now. If the approved policy has moved since,
    // this worker would run the job under the old boundary - so it is refused
    // rather than run. Approving through the app retires workers eagerly; this
    // also covers approving through the CLI, which writes the cache directly.
    if (instance.policyDrifted) {
      this.log(
        'debug',
        `[instance ${instanceNum}] Policy drifted for this worker; leaving it constrained rather than reapplying`
      );
      return;
    }

    const currentStamp = this.stampFor(policy);
    if (isClaim && instance.policyStamp && instance.policyStamp !== currentStamp) {
      // The filesystem half is fixed in this worker's profile and cannot be
      // updated, so the job runs under the boundary that was approved when the
      // worker started. That boundary was approved by the machine owner, just
      // not most recently. Network is cut back to runner infrastructure and the
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
    proxy.setLoopbackPolicy(this.brokerPort(), policy.loopback);
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
    // this process holds the slot, it is this job's.
    const worker = instance.process;
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
    const stop = worker && this.instances.get(instanceNum) === instance && instance.process === worker
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

  /** Where worker pids are recorded, outside anything a job can write. */
  private pidDir(): string {
    return path.join(getRunnerDir(), 'pids');
  }

  /**
   * A pid worth signalling: a positive integer, not this process, and not one
   * this manager is currently running. Rejects 0 and negatives outright -
   * process.kill(-1) would signal every process the user owns and kill(0) the
   * whole group, so a stale or planted file must never reach them.
   */
  private sweepablePid(raw: string, live: Set<number>): number | null {
    // Line one is "<pid> <start time>"; line two, if present, the marker path,
    // which the marker sweep handles separately. Digits-only pid: parseInt
    // would take '1234junk' as 1234.
    const { pid, recordedStart } = parsePidRecord(raw);
    if (pid === null || pid <= 1 || pid === process.pid || live.has(pid)) return null;
    // The pid must still belong to the process this app recorded. A missing
    // record or a start-time mismatch means the pid was reused, so it is not
    // ours to signal.
    if (recordedStart === '' || processStartTime(pid) !== recordedStart) return null;
    return pid;
  }

  /** Marker files left in the pid directory by spawns that were never finalized. */
  private async readMarkers(): Promise<string[]> {
    const pidDir = this.pidDir();
    if (!fs.existsSync(pidDir)) return [];
    const entries = await fs.promises.readdir(pidDir, { withFileTypes: true });
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((entry) => !entry.isDirectory() && /^\d+-[0-9a-f]+\.mark$/.test(entry.name))
      .map((entry) => path.join(pidDir, entry.name));
  }

  /** The pid files this manager wrote, as [absolute path, pid string]. */
  private async readPidFiles(): Promise<Array<[string, string]>> {
    const pidDir = this.pidDir();
    if (!fs.existsSync(pidDir)) return [];
    const entries = await fs.promises.readdir(pidDir, { withFileTypes: true });
    if (!Array.isArray(entries)) return [];
    const out: Array<[string, string]> = [];
    for (const entry of entries) {
      if (entry.isDirectory() || !/^\d+\.pid$/.test(entry.name)) continue;
      const file = path.join(pidDir, entry.name);
      try {
        out.push([file, await fs.promises.readFile(file, 'utf-8')]);
      } catch {
        // Unreadable: skip, and leave the file for a later pass.
      }
    }
    return out;
  }

  /**
   * Signal a worker's whole process group, falling back to the leader alone if
   * the group is gone. Workers spawn detached, so the leader pid is the group
   * id and a negative pid reaches every descendant.
   */
  private signalGroupOrLeader(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
  }

  private async killStaleProcesses(): Promise<void> {
    // Processes this manager is running right now. A sweep that trusts a pid
    // file alone will kill a runner spawned seconds earlier: seen live, where
    // auto-start brought instance 1 up as pid 5748 and this killed it one
    // second later, leaving the pool empty and the runner Offline for eight
    // hours while heartbeats carried on as though nothing were wrong.
    // Markers first: each names the surviving holders of one spawn's
    // descriptor, leader alive or not, so a leaderless orphan group - which
    // the pid/start-time path below cannot verify - is reaped here. Ownership is
    // decided per marker at the moment it is examined, never from a snapshot
    // taken before an await: the broker is already accepting jobs while this
    // runs, so a worker can spawn at any wait.
    const kept: string[] = [];
    for (const markerPath of await this.readMarkers()) {
      if ((await this.sweepMarker(markerPath, 1000)) === 'kept') kept.push(path.basename(markerPath));
    }
    if (kept.length > 0) {
      this.log('warn', `Kept ${kept.length} marker file(s) for the next sweep: ${kept.join(', ')}`);
    }

    for (const [pidFile, contents] of await this.readPidFiles()) {
      // Liveness is read now, for the same reason.
      const live = this.livePids();
      const pid = this.sweepablePid(contents, live);
      if (pid === null) {
        // Either not ours to kill, or a value we refuse to signal. Drop the
        // file if it names nothing runnable; keep it if it is a live worker.
        if (!live.has(parseInt(contents.trim(), 10))) {
          await fs.promises.unlink(pidFile).catch(() => undefined);
        }
        continue;
      }
      // sweepablePid matched it against the record, so this is the start
      // time the SIGTERM below goes to.
      const { recordedStart } = parsePidRecord(contents);
      try {
        process.kill(pid, 0);
        this.log('info', `Killing stale runner process group ${pid}`);
        // Negative pid: a worker is spawned detached as its own group leader,
        // so this reaches its descendants too - a crashed worker's children,
        // reparented to launchd, are the orphans this sweep exists for.
        this.signalGroupOrLeader(pid, 'SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        // Liveness alone cannot tell the worker from a process that took its
        // pid after it exited on the SIGTERM; the start time can, as it did
        // before the SIGTERM. A leader gone with descendants left in its
        // group is still escalated (mayEscalate, as in runner-cleanup).
        if (!mayEscalate(recordedStart, lookUpStartTime(pid))) {
          this.log('info', `Stale runner ${pid} exited; its pid now belongs to another process, which is left alone`);
        } else {
          try {
            // Probe the group, not just the leader: a leader can exit while a
            // descendant ignores SIGTERM, and kill(pid, 0) on the dead leader
            // would skip the SIGKILL the descendant still needs.
            process.kill(-pid, 0);
            this.signalGroupOrLeader(pid, 'SIGKILL');
          } catch {
            try {
              // Group gone, but the leader itself may linger; escalate to it.
              process.kill(pid, 0);
              this.signalGroupOrLeader(pid, 'SIGKILL');
            } catch {
              // Everything exited after SIGTERM - the expected success case.
            }
          }
        }
      } catch {
        // Process doesn't exist (ESRCH) - already dead
      }
      await fs.promises.unlink(pidFile).catch(() => undefined);
    }
  }

  private async detectStaleRunnerProcesses(): Promise<void> {
    const orphanedPids: number[] = [];
    const recordedStarts = new Map<number, string>();
    try {
      for (const [pidFile, contents] of await this.readPidFiles()) {
        // Liveness is read now, not from a snapshot taken before the await.
        const live = this.livePids();
        const pid = this.sweepablePid(contents, live);
        if (pid === null) {
          if (!live.has(parseInt(contents.trim(), 10))) {
            await fs.promises.unlink(pidFile).catch(() => undefined);
          }
          continue;
        }
        try {
          process.kill(pid, 0);
          orphanedPids.push(pid);
          recordedStarts.set(pid, parsePidRecord(contents).recordedStart);
        } catch {
          await fs.promises.unlink(pidFile).catch(() => undefined);
        }
      }

      if (orphanedPids.length > 0) {
        this.log('warn', `Found ${orphanedPids.length} orphaned runner process(es): ${orphanedPids.join(', ')}`);

        for (const pid of orphanedPids) {
          // Verified above, but that was before an await; a worker may have
          // spawned since.
          if (this.livePids().has(pid)) continue;
          try {
            this.log('info', `Killing orphaned process ${pid}`);
            process.kill(pid, 'SIGTERM');

            await new Promise((resolve) => setTimeout(resolve, 1000));
            // Only the process that was sent SIGTERM: one that took its pid
            // since has another start time.
            if (!mayEscalate(recordedStarts.get(pid), lookUpStartTime(pid))) continue;
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
