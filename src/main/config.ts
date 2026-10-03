/**
 * Configuration management: loading, saving, and type definitions.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { getAppDataDir, getConfigPath } from './paths';
import { encryptValue, decryptValue } from './encryption';
import { bootLog } from './log-file';
import {
  GitHubUser,
  SleepProtection,
  LogLevel,
  UserFilterConfig,
  Target,
  PowerConfig,
  NotificationsConfig,
  UpdateSettings,
} from '../shared/types';
import type { ResourcePauseConfig, JobEnvironmentConfig } from '../shared/job-preferences';
import type { IsolationConfig } from '../shared/isolation';

// Config paths - uses centralized path management
const configDir = getAppDataDir();
const configPath = getConfigPath();

/**
 * On-disk config format version. Bump when the format changes in a way an older
 * build would mishandle. Every save stamps this; loaders/savers refuse to write
 * over a file that carries a HIGHER version, so a stale or older app bundle
 * sharing the same config dir cannot silently downgrade (and lose) it.
 */
export const CONFIG_VERSION = 1;

/**
 * True when a config on disk was written by a newer build than this one.
 * An absent or non-numeric version is legacy, not newer.
 */
export const isConfigFromNewerBuild = (version: unknown): boolean =>
  typeof version === 'number' && version > CONFIG_VERSION;

/**
 * Keys that can be set via the SETTINGS_SET IPC handler.
 * This is the source of truth - TypeScript derives the type from this array.
 * Note: 'auth' and 'githubClientId' are intentionally excluded (set via auth flow),
 * and so is 'targets': only the target manager writes them, after checking
 * each name, and the renderer only ever echoed back what it had read.
 */
export const SETTABLE_CONFIG_KEYS = [
  'runnerConfig',
  'theme',
  'launchAtLogin',
  'hideOnStart',
  'sleepProtection',
  'logLevel',
  'runnerLogLevel',
  'userFilter',
  'maxConcurrentJobs',
  'power',  // Power settings (battery/video call pausing)
  'notifications',
  'resourcePause',  // What a resource pause does to running jobs
  'jobEnvironment',  // What localmost adds to each job's environment
  'isolation',  // Which isolation types this Mac allows a job to get
] as const;

export type SettableConfigKey = typeof SETTABLE_CONFIG_KEYS[number];

export interface AppConfig {
  /** On-disk config format version. Used to refuse downgrades by an older build. */
  configVersion?: number;
  githubClientId?: string;
  auth?: {
    accessToken?: string;  // Optional - obtained fresh on startup, not persisted
    refreshToken?: string;
    expiresAt?: number;  // Unix timestamp (ms) when access token expires
    user: GitHubUser;
    /** The refresh token is spent: the session is known but unusable. */
    expired?: boolean;
  };
  runnerConfig?: {
    level: 'repo' | 'org';
    repoUrl?: string;
    orgName?: string;
    runnerName?: string;
    labels?: string;
    runnerCount?: number;  // Number of parallel runners (1-8)
  };
  theme?: string;
  launchAtLogin?: boolean;
  hideOnStart?: boolean;
  sleepProtection?: SleepProtection;
  logLevel?: LogLevel;
  runnerLogLevel?: LogLevel;
  userFilter?: UserFilterConfig;
  /** Sandbox policy level for all restrictions. Defaults to 'strict' */
  /** Auto-update preferences */
  updateSettings?: UpdateSettings;
  /** Multi-target configuration - list of repos/orgs to register runners for */
  targets?: Target[];
  /** Maximum concurrent jobs across all targets (1-8, defaults to 4) */
  maxConcurrentJobs?: number;
  /** Power settings (battery/video call pausing) */
  power?: PowerConfig;
  /** Notification settings */
  notifications?: NotificationsConfig;
  /** The per-job Docker VMs; read from config.yaml only, see resolveDockerVmConfig. */
  dockerVm?: Partial<Record<keyof DockerVmConfig, unknown>>;
  /** What a resource pause does; see ResourcePauseConfig and resolveResourcePauseConfig. */
  resourcePause?: Partial<Record<keyof ResourcePauseConfig, unknown>>;
  /** What localmost adds to each job's environment; see resolveJobEnvironmentConfig. */
  jobEnvironment?: Partial<Record<keyof JobEnvironmentConfig, unknown>>;
  /**
   * Which isolation types this Mac allows a job to get: `allowed`, a list of
   * `seatbelt`, `service-account`, `macos-vm`. Seatbelt alone by default in
   * this build, the only type it can run; the VM alone from the build that
   * ships the macOS VM type. A repository's .localmostrc orders the types it
   * accepts, and a job gets the first that is both allowed here and
   * available in this build, or is refused. See resolveIsolationConfig and
   * docs/roadmap/localmostrc.md (Isolation).
   */
  isolation?: Partial<Record<keyof IsolationConfig, unknown>>;
}

// The resource-pause and job-environment preferences, with their defaults
// and resolvers, live in shared/job-preferences, where the Settings page
// reads them too.
export {
  DEFAULT_RESOURCE_PAUSE_CONFIG,
  DEFAULT_JOB_ENVIRONMENT_CONFIG,
  resolveResourcePauseConfig,
  resolveJobEnvironmentConfig,
} from '../shared/job-preferences';
export type { ResourcePauseConfig, JobEnvironmentConfig } from '../shared/job-preferences';

/**
 * The per-job Docker VMs, as used: every key present, in range. See
 * docs/roadmap/vm-docker-backend-contract.md §5.6. No key enables a fallback
 * daemon; there is none.
 */
export interface DockerVmConfig {
  /** Boot one spare VM for the next spawned worker: memory for latency. */
  prewarm: boolean;
  /** Per VM. */
  cpus: number;
  /** Per VM; committed lazily, returned only when the VM stops. */
  memoryMiB: number;
  /** How many VMs may run at once; more wait at the admission gate. */
  maxRunning: number;
  /** Every VM's sparse data disk, the golden disk's size; and the most free space set aside for one. */
  dataDiskGiB: number;
  /** How long a docker request waits for the job's VM. */
  bootTimeoutSec: number;
  /** Per repository: golden disk and image store, least recently used dropped at refresh. */
  cacheLimitGiB: number;
  /** Compressed bytes one pull may fetch. */
  pullMaxGiB: number;
  /** Compressed bytes all of one job's pulls may fetch. */
  jobPullMaxGiB: number;
  /** Free space on the data directory's volume under which boots and pulls are refused. */
  minFreeGiB: number;
}

/** What resolveDockerVmConfig sizes its defaults from. */
export interface DockerVmHost {
  cores: number;
  memoryBytes: number;
}

/** Each numeric key's range; a value outside it is clamped and logged. 0 for maxRunning means automatic. */
const DOCKER_VM_RANGES: Record<Exclude<keyof DockerVmConfig, 'prewarm'>, [number, number]> = {
  cpus: [1, 64],
  memoryMiB: [1024, 65536],
  maxRunning: [0, 64],
  dataDiskGiB: [8, 4096],
  bootTimeoutSec: [5, 600],
  cacheLimitGiB: [1, 4096],
  pullMaxGiB: [1, 1024],
  jobPullMaxGiB: [1, 4096],
  minFreeGiB: [1, 4096],
};

/**
 * The `dockerVm` section as the running app reads it: resolved once, and
 * again only when refresh() is called, at each worker spawn. The VM manager
 * reads it at every state change and every 10 s while VMs run, and a read of
 * config.yaml is synchronous file I/O on Electron main. Each warning is
 * logged once for each distinct text, so a clamped value is reported once,
 * not at every read.
 */
export class DockerVmConfigSource {
  private cached: DockerVmConfig | undefined;
  private readonly logged = new Set<string>();

  constructor(
    private readonly opts: {
      read: () => AppConfig['dockerVm'] | undefined;
      host: DockerVmHost;
      log: (message: string) => void;
    }
  ) {}

  current(): DockerVmConfig {
    this.cached ??= this.resolve();
    return this.cached;
  }

  refresh(): DockerVmConfig {
    this.cached = this.resolve();
    return this.cached;
  }

  private resolve(): DockerVmConfig {
    return resolveDockerVmConfig(this.opts.read(), this.opts.host, (message) => {
      if (this.logged.has(message)) return;
      this.logged.add(message);
      this.opts.log(message);
    });
  }
}

/**
 * The `dockerVm` section of config.yaml as the VM backend uses it. Every key
 * is optional. A value of the wrong type is taken as absent, and one out of
 * range is clamped, each with a line through `log`; keys it does not know
 * are ignored.
 */
export function resolveDockerVmConfig(
  raw: AppConfig['dockerVm'] | undefined,
  host: DockerVmHost,
  log: (message: string) => void = () => {}
): DockerVmConfig {
  const GiB = 1024 ** 3;
  const defaults: DockerVmConfig = {
    prewarm: false,
    cpus: Math.max(1, Math.min(4, host.cores)),
    memoryMiB: 8192,
    maxRunning: 0,
    dataDiskGiB: 64,
    bootTimeoutSec: 60,
    cacheLimitGiB: 20,
    pullMaxGiB: 10,
    jobPullMaxGiB: 30,
    minFreeGiB: 20,
  };
  const section: Record<string, unknown> = typeof raw === 'object' && raw !== null ? raw : {};
  const resolved: DockerVmConfig = { ...defaults };

  if (section.prewarm !== undefined) {
    if (typeof section.prewarm === 'boolean') resolved.prewarm = section.prewarm;
    else log(`dockerVm.prewarm must be true or false; using ${defaults.prewarm}`);
  }
  for (const key of Object.keys(DOCKER_VM_RANGES) as Array<keyof typeof DOCKER_VM_RANGES>) {
    const value = section[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      log(`dockerVm.${key} must be a whole number; using ${defaults[key]}`);
      continue;
    }
    const [min, max] = DOCKER_VM_RANGES[key];
    const clamped = Math.min(max, Math.max(min, value));
    if (clamped !== value) log(`dockerVm.${key} ${value} is outside ${min}-${max}; using ${clamped}`);
    resolved[key] = clamped;
  }
  if (resolved.jobPullMaxGiB < resolved.pullMaxGiB) {
    log(`dockerVm.jobPullMaxGiB ${resolved.jobPullMaxGiB} is less than pullMaxGiB; using ${resolved.pullMaxGiB}`);
    resolved.jobPullMaxGiB = resolved.pullMaxGiB;
  }
  if (resolved.maxRunning === 0) {
    resolved.maxRunning = Math.max(1, Math.floor(host.memoryBytes / GiB / 8));
  }
  return resolved;
}

/**
 * Load configuration from YAML file with decryption.
 */
export const loadConfig = (): AppConfig => {
  let config: AppConfig = {};
  const oldJsonPath = path.join(configDir, 'config.json');

  // Migrate from old JSON config if it exists and YAML doesn't
  if (fs.existsSync(oldJsonPath) && !fs.existsSync(configPath)) {
    try {
      const jsonContent = fs.readFileSync(oldJsonPath, 'utf-8');
      config = JSON.parse(jsonContent) as AppConfig;
      // Save as YAML
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, yaml.dump(config, { indent: 2, lineWidth: -1 }));
      // Remove old JSON file
      fs.unlinkSync(oldJsonPath);
      bootLog('info', 'Migrated config from JSON to YAML');
    } catch (e) {
      bootLog('warn', `Failed to migrate JSON config: ${(e as Error).message}`);
    }
  }

  // Load from YAML config file
  try {
    if (fs.existsSync(configPath)) {
      const yamlContent = fs.readFileSync(configPath, 'utf-8');
      config = (yaml.load(yamlContent, { schema: yaml.JSON_SCHEMA }) as AppConfig) || {};
    }
  } catch (e) {
    bootLog('warn', `Failed to load YAML config: ${(e as Error).message}`);
  }

  // Decrypt sensitive auth data if present
  // We only persist refreshToken and user - access tokens are obtained fresh on startup
  if (config.auth) {
    try {
      if (config.auth.refreshToken) {
        config.auth.refreshToken = decryptValue(config.auth.refreshToken);
      }
      // Clear any persisted access token - we'll get a fresh one on startup
      delete config.auth.accessToken;
      delete config.auth.expiresAt;
    } catch (e) {
      bootLog('warn', `Failed to decrypt auth tokens: ${(e as Error).message}`);
      delete config.auth;
    }
  }

  return config;
};

/**
 * Save configuration to YAML file with encryption.
 */
export const saveConfig = (config: AppConfig): void => {
  try {
    fs.mkdirSync(configDir, { recursive: true });

    // Refuse to downgrade a config written by a newer build. Reading only the
    // version keeps this cheap and tolerant of an otherwise-unreadable file
    // (the atomic write below still replaces genuine corruption).
    if (fs.existsSync(configPath)) {
      try {
        const existing = yaml.load(fs.readFileSync(configPath, 'utf-8'), { schema: yaml.JSON_SCHEMA }) as AppConfig | undefined;
        if (existing && isConfigFromNewerBuild(existing.configVersion)) {
          bootLog('error', `Refusing to save config: on-disk version ${existing.configVersion} is newer than this build (${CONFIG_VERSION}); a downgrade would clobber it`);
          return;
        }
      } catch {
        // Unreadable existing config: not a version downgrade. Fall through and
        // let the normal (atomic) save replace it.
      }
    }

    // Create a copy to avoid mutating the original config
    const configToSave: AppConfig = { ...config, configVersion: CONFIG_VERSION };

    // Only persist refreshToken and user - access tokens are obtained fresh on
    // startup - plus whether the session is known to be spent. Dropping that
    // flag meant a restart forgot, presented the account as healthy, and went
    // back to refreshing a token that can never work.
    if (configToSave.auth) {
      const { refreshToken, user, expired } = configToSave.auth;
      if (refreshToken) {
        configToSave.auth = {
          refreshToken: encryptValue(refreshToken),
          user,
          ...(expired ? { expired: true } : {}),
        };
      } else {
        // No refresh token means we can't persist auth
        delete configToSave.auth;
      }
    }

    // Atomic write: serialize to a temp file, then rename over the real one.
    // A rename is atomic, so a reader (or a second app instance) never sees a
    // half-written file, and a failure part-way through leaves the previous
    // config intact instead of truncating it in place.
    const tempPath = `${configPath}.tmp`;
    fs.writeFileSync(tempPath, yaml.dump(configToSave, { indent: 2, lineWidth: -1 }));
    fs.renameSync(tempPath, configPath);
  } catch (e) {
    bootLog('error', `Failed to save config: ${(e as Error).message}`);
  }
};

/**
 * Get config directory path.
 */
export const getConfigDir = (): string => configDir;
