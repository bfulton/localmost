/**
 * Centralized constants for the localmost application.
 * All magic numbers and configuration values should be defined here.
 */

// OAuth credentials are injected at build time via the OAUTH_CONFIG in build-info.ts
// See scripts/generate-build-info.js for how these values are set from environment variables
import { OAUTH_CONFIG } from './build-info';

// =============================================================================
// Application Info
// =============================================================================

export const APP_NAME = 'localmost';
export const REPOSITORY_URL = 'https://github.com/bfulton/localmost';
export const PRIVACY_POLICY_URL = 'https://github.com/bfulton/localmost/blob/main/PRIVACY.md';

// =============================================================================
// GitHub OAuth Configuration
// =============================================================================

/**
 * GitHub App client ID for OAuth device flow authentication.
 * Injected at build time from LOCALMOST_GITHUB_CLIENT_ID environment variable.
 */
export const DEFAULT_GITHUB_CLIENT_ID = OAUTH_CONFIG.clientId;

/**
 * GitHub OAuth App ID (shown in settings links).
 * Injected at build time from LOCALMOST_GITHUB_OAUTH_APP_ID environment variable.
 */
export const GITHUB_OAUTH_APP_ID = OAUTH_CONFIG.oauthAppId;

/** URL for users to manage their GitHub OAuth app connection */
export const GITHUB_APP_SETTINGS_URL = `https://github.com/settings/connections/applications/${GITHUB_OAUTH_APP_ID}`;

// =============================================================================
// Timing & Intervals
// =============================================================================

/** Device flow polling interval (ms) */
export const DEVICE_FLOW_POLL_INTERVAL_MS = 5000;

/** Device flow polling timeout (ms) - 5 minutes */
export const DEVICE_FLOW_POLL_TIMEOUT_MS = 5 * 60 * 1000;

/** Token refresh check interval (ms) - 1 hour */
export const TOKEN_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/** Token proactive refresh window (ms) - refresh if expires within 2 hours */
export const TOKEN_REFRESH_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Delay before auto-starting runner on app launch (ms) */
export const AUTO_START_DELAY_MS = 2000;

/** Heartbeat update interval (ms) - 1 minute */
export const HEARTBEAT_INTERVAL_MS = 60 * 1000;

/** Heartbeat staleness threshold (ms) - 90 seconds */
export const HEARTBEAT_STALE_THRESHOLD_MS = 90 * 1000;

/** Heartbeat variable name (stored in repo/org Actions variables) */
export const HEARTBEAT_VARIABLE_NAME = 'LOCALMOST_HEARTBEAT';

// =============================================================================
// Tray Icon Animation
// =============================================================================

/** Number of frames in the tray icon animation */
export const TRAY_ANIMATION_FRAMES = 8;

/** Interval between animation frames (ms) - 200ms = 1.6s full cycle */
export const TRAY_ANIMATION_INTERVAL_MS = 200;

// =============================================================================
// Logging
// =============================================================================

/** Maximum number of log files to keep */
export const MAX_LOG_FILES = 10;

// =============================================================================
// Runner Configuration
// =============================================================================

/** Default number of parallel runner instances */
export const DEFAULT_RUNNER_COUNT = 4;

/** Minimum number of runner instances */
export const MIN_RUNNER_COUNT = 1;

/** Maximum number of runner instances */
export const MAX_RUNNER_COUNT = 16;

/** Default max job history entries to keep */
export const DEFAULT_MAX_JOB_HISTORY = 10;

/** Fallback runner version if GitHub API fails */
export const FALLBACK_RUNNER_VERSION = '2.330.0';

// =============================================================================
// UI Defaults
// =============================================================================

/** Default max log scrollback lines */
export const DEFAULT_MAX_LOG_SCROLLBACK = 500;

/** Minimum log scrollback lines */
export const MIN_LOG_SCROLLBACK = 50;

/** Maximum log scrollback lines */
export const MAX_LOG_SCROLLBACK = 5000;

/** Minimum job history entries */
export const MIN_JOB_HISTORY = 5;

/** Maximum job history entries */
export const MAX_JOB_HISTORY = 50;

// =============================================================================
// Auto-Update
// =============================================================================

/** Delay before checking for updates on app launch (ms) - 10 seconds */
export const UPDATE_CHECK_DELAY_MS = 10 * 1000;

/** Default update check interval (hours) */
export const DEFAULT_UPDATE_CHECK_INTERVAL_HOURS = 24;
