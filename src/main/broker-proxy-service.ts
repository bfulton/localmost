/**
 * Broker Proxy Service
 *
 * A local HTTP server that sits between runner workers and GitHub's broker.
 * Multiplexes connections to multiple GitHub targets (repos/orgs).
 *
 * Architecture:
 * - Workers connect to localhost (this proxy)
 * - Proxy maintains sessions with GitHub broker for each target
 * - Jobs from any target are routed to available workers
 * - Workers don't need to know about multi-target complexity
 */

import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { getLogger } from './app-state';
import type { Target, RunnerProxyStatus } from '../shared/types';

// Helper to get logger (may be null before initialization)
const log = () => getLogger();

// ============================================================================
// Types
// ============================================================================

/** Runner config from .runner file */
interface RunnerFileConfig {
  agentId: number;
  agentName: string;
  poolId: number;
  poolName: string;
  serverUrl: string;
  gitHubUrl: string;
  workFolder: string;
  useV2Flow: boolean;
  serverUrlV2: string;
}

/** Credentials from .credentials file */
interface CredentialsFile {
  scheme: string;
  data: {
    clientId: string;
    authorizationUrl: string;
    requireFipsCryptography: string;
  };
}

/** RSA parameters from .credentials_rsaparams file */
interface RSAParamsFile {
  d: string;
  dp: string;
  dq: string;
  exponent: string;
  inverseQ: string;
  modulus: string;
  p: string;
  q: string;
}

/** Internal target state with credentials and session info */
interface TargetState {
  target: Target;
  runner: RunnerFileConfig;
  credentials: CredentialsFile;
  rsaParams: RSAParamsFile;
  accessToken?: string;
  tokenExpiry?: number;
  sessionId?: string;
  lastPoll?: Date;
  jobsAssigned: number;
  error?: string;
}

/** Local session for a connected worker */
interface LocalSession {
  id: string;
  createdAt: Date;
  workerId?: number;
  targetId?: string;  // Which target this session is handling
  currentJobId?: string;  // Job currently being executed
}

/** Job assignment tracking */
interface JobAssignment {
  jobId: string;
  targetId: string;
  sessionId: string;
  workerId?: number;
  assignedAt: Date;
}

// ============================================================================
// HTTP Helpers
// ============================================================================

function httpsRequest(
  url: string,
  options: https.RequestOptions,
  body?: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      ...options,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}

// ============================================================================
// Crypto Helpers
// ============================================================================

function buildPrivateKey(rsaParams: RSAParamsFile): crypto.KeyObject {
  const jwk = {
    kty: 'RSA',
    n: Buffer.from(rsaParams.modulus, 'base64').toString('base64url'),
    e: Buffer.from(rsaParams.exponent, 'base64').toString('base64url'),
    d: Buffer.from(rsaParams.d, 'base64').toString('base64url'),
    p: Buffer.from(rsaParams.p, 'base64').toString('base64url'),
    q: Buffer.from(rsaParams.q, 'base64').toString('base64url'),
    dp: Buffer.from(rsaParams.dp, 'base64').toString('base64url'),
    dq: Buffer.from(rsaParams.dq, 'base64').toString('base64url'),
    qi: Buffer.from(rsaParams.inverseQ, 'base64').toString('base64url'),
  };
  return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
}

function createJWT(clientId: string, authorizationUrl: string, privateKey: crypto.KeyObject): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    sub: clientId,
    iss: clientId,
    aud: authorizationUrl,
    iat: now,
    exp: now + 60,
    nbf: now,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), privateKey);

  return `${signingInput}.${signature.toString('base64url')}`;
}

// ============================================================================
// Broker Proxy Service
// ============================================================================

export interface BrokerProxyEvents {
  'status-update': (status: RunnerProxyStatus[]) => void;
  'job-received': (targetId: string, jobId: string) => void;
  'error': (targetId: string, error: Error) => void;
}

export class BrokerProxyService extends EventEmitter {
  private port: number;
  private server: http.Server | null = null;
  private targets: Map<string, TargetState> = new Map();
  private localSessions: Map<string, LocalSession> = new Map();
  private jobAssignments: Map<string, JobAssignment> = new Map();
  private isRunning = false;
  private isShuttingDown = false;
  private runnerVersion = '2.330.0';
  private pollInterval: NodeJS.Timeout | null = null;
  private isPolling = false;  // Prevent concurrent poll execution
  private messageQueues: Map<string, Array<string>> = new Map();  // Per-target message queues
  private seenMessageIds: Set<string> = new Set();
  private pendingTargetAssignments: string[] = [];  // Queue of target IDs for upcoming sessions
  private jobRunServiceUrls: Map<string, string> = new Map();  // jobId -> run_service_url for job operations
  private acquiredJobDetails: Map<string, string> = new Map();  // jobId -> job details from acquireJobUpstream
  private jobInfo: Map<string, { billingOwnerId?: string; runServiceUrl: string }> = new Map();  // messageId -> job info
  private canAcceptJobCallback?: () => boolean;
  private sessionRetryTimeouts: Map<string, NodeJS.Timeout> = new Map();  // targetId -> retry timeout

  /** How often to poll targets for jobs (ms) */
  private static readonly POLL_INTERVAL_MS = 5000;
  /** How long to wait before retrying failed session creation (ms) */
  private static readonly SESSION_RETRY_INTERVAL_MS = 30000;

  constructor(port = 8787) {
    super();
    this.port = port;
  }

  /**
   * Set a callback to check if we can accept more jobs.
   * If this returns false, we won't acquire new jobs from GitHub.
   */
  setCanAcceptJobCallback(callback: () => boolean): void {
    this.canAcceptJobCallback = callback;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Add a target to the proxy.
   * The target must have valid credentials loaded from runner proxy registration.
   */
  addTarget(
    target: Target,
    runner: RunnerFileConfig,
    credentials: CredentialsFile,
    rsaParams: RSAParamsFile
  ): void {
    this.targets.set(target.id, {
      target,
      runner,
      credentials,
      rsaParams,
      jobsAssigned: 0,
    });
    log()?.info(`[BrokerProxy] Added target: ${target.displayName}`);
  }

  /**
   * Remove a target from the proxy.
   */
  removeTarget(targetId: string): void {
    const state = this.targets.get(targetId);
    if (state) {
      // Clean up session if exists
      this.deleteUpstreamSession(state).catch(() => {});
      this.targets.delete(targetId);
      log()?.info( `[BrokerProxy] Removed target: ${state.target.displayName}`);
    }
  }

  /**
   * Start the proxy server and begin polling for jobs.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    // Reset shutdown flag in case we're restarting
    this.isShuttingDown = false;

    // Start HTTP server for workers to connect to
    await new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (err) => {
        log()?.error( `[BrokerProxy] Server error: ${err.message}`);
        reject(err);
      });

      this.server.listen(this.port, () => {
        this.isRunning = true;
        log()?.info( `[BrokerProxy] Listening on http://localhost:${this.port}`);
        resolve();
      });
    });

    // Create upstream sessions for all targets
    const enabledTargets = Array.from(this.targets.values())
      .filter(s => s.target.enabled);

    for (const state of enabledTargets) {
      try {
        await this.createUpstreamSession(state);
      } catch (error) {
        log()?.error(`[BrokerProxy] Failed to create session for ${state.target.displayName}: ${(error as Error).message}`);
        state.error = (error as Error).message;
        // Schedule background retry for failed session
        this.scheduleSessionRetry(state);
      }
    }

    this.emitStatusUpdate();

    // Start active polling for jobs
    this.startPolling();
  }

  /**
   * Start the active polling loop to check all targets for jobs.
   */
  private startPolling(): void {
    if (this.pollInterval) return;

    log()?.info('[BrokerProxy] Starting active job polling...');

    const poll = async () => {
      if (!this.isRunning) return;

      // Prevent concurrent poll execution
      if (this.isPolling) {
        log()?.debug('[BrokerProxy] Skipping poll - previous poll still in progress');
        return;
      }
      this.isPolling = true;

      try {
      // Poll all enabled targets with active sessions
      // Since we acquire jobs immediately, GitHub won't return the same job twice
      const allTargets = Array.from(this.targets.values());
      const enabledTargets = allTargets.filter(s => s.target.enabled && s.sessionId);

      log()?.debug(`[BrokerProxy] Polling ${enabledTargets.length}/${allTargets.length} targets`);

      if (enabledTargets.length === 0) return;

      // Poll all targets concurrently
      const pollPromises = enabledTargets.map(async (state) => {
        try {
          const result = await this.pollUpstreamTarget(state);
          return { state, ...result };
        } catch (error) {
          state.error = (error as Error).message;
          return { state, hasMessage: false, body: '' };
        }
      });

      const results = await Promise.all(pollPromises);

      for (const result of results) {
        if (result.hasMessage) {
          log()?.info(`[BrokerProxy] Processing message from ${result.state.target.displayName}, body length=${result.body.length}`);
          // Parse message to determine type
          let message;
          try {
            message = JSON.parse(result.body);
            log()?.info(`[BrokerProxy] Parsed: messageType=${message.messageType}, bodyType=${typeof message.body}`);
          } catch (e) {
            log()?.info(`[BrokerProxy] Could not parse message from ${result.state.target.displayName}: ${(e as Error).message}`);
            continue;
          }

          const messageType = message.messageType || '';
          // Extract messageId as string from raw JSON to avoid precision loss with large integers
          const messageIdMatch = result.body.match(/"messageId"\s*:\s*(\d+)/);
          const messageId = messageIdMatch ? messageIdMatch[1] : (message.messageId ? String(message.messageId) : crypto.createHash('sha256').update(result.body).digest('hex').slice(0, 16));

          // Parse the inner body if it's a string (GitHub wraps the actual message)
          let innerBody = message.body;
          if (typeof innerBody === 'string') {
            try {
              innerBody = JSON.parse(innerBody);
            } catch {
              // Keep as string if not valid JSON
            }
          }

          // Check if this is a job assignment
          // GitHub sends RunnerJobRequest with runner_request_id (not jobId)
          const isJobMessage = messageType.toLowerCase().includes('job');
          const jobId = innerBody?.jobId || innerBody?.runner_request_id;
          const targetId = result.state.target.id;

          log()?.info(`[BrokerProxy] Message: type=${messageType}, isJob=${isJobMessage}, jobId=${jobId}`);
          // Debug: log all fields in innerBody
          if (innerBody && typeof innerBody === 'object') {
            log()?.info(`[BrokerProxy] innerBody fields: ${Object.keys(innerBody).join(', ')}`);
          }

          if (isJobMessage && jobId) {
            // Deduplicate by job ID - don't spawn multiple workers for the same job
            if (this.jobAssignments.has(jobId)) {
              log()?.debug(`[BrokerProxy] Skipping duplicate job ${jobId}`);
              continue;
            }

            // Check if we have capacity to accept more jobs
            if (this.canAcceptJobCallback && !this.canAcceptJobCallback()) {
              log()?.info(`[BrokerProxy] At capacity, skipping job ${jobId}`);
              continue;
            }

            // Store real run_service_url for forwarding job operations
            // Store by multiple keys since runner may use different IDs
            const runServiceUrl = innerBody?.run_service_url;
            const billingOwnerId = innerBody?.billing_owner_id;
            if (runServiceUrl) {
              this.jobRunServiceUrls.set(jobId, runServiceUrl);
              // Also store by messageId (used as jobMessageId in acquirejob)
              // messageId was extracted as string to avoid precision loss
              this.jobRunServiceUrls.set(messageId, runServiceUrl);
              // Store job info for acquireJobUpstream
              this.jobInfo.set(messageId, { billingOwnerId, runServiceUrl });
              log()?.info(`[BrokerProxy] Job ${jobId} (messageId=${messageId}) received from ${result.state.target.displayName}, run_service_url=${runServiceUrl}, billingOwnerId=${billingOwnerId}`);
            } else {
              log()?.info(`[BrokerProxy] Job ${jobId} received from ${result.state.target.displayName} (no run_service_url)`);
            }

            // Acquire job from GitHub immediately using target's credentials
            // This claims the job so GitHub won't keep sending it on subsequent polls
            // Note: GitHub uses runner_request_id (UUID) as jobMessageId, not the broker's numeric messageId
            if (runServiceUrl) {
              const jobDetails = await this.acquireJobUpstream(result.state, jobId, runServiceUrl, billingOwnerId);
              if (jobDetails) {
                this.acquiredJobDetails.set(jobId, jobDetails);
                this.acquiredJobDetails.set(messageId, jobDetails);
                log()?.info(`[BrokerProxy] Acquired job ${jobId} (messageId=${messageId}) upstream, stored details`);
              } else {
                log()?.warn(`[BrokerProxy] Failed to acquire job ${jobId} upstream, continuing anyway`);
              }
            }

            // Rewrite run_service_url to point to our proxy
            // This ensures the runner talks to us, not directly to GitHub
            const proxyUrl = `http://localhost:${this.port}/`;
            innerBody.run_service_url = proxyUrl;

            // Rebuild the message with rewritten URL
            message.body = JSON.stringify(innerBody);
            const rewrittenMessage = JSON.stringify(message);
            log()?.info(`[BrokerProxy] Rewrote run_service_url to ${proxyUrl}`);

            // Queue the rewritten message for the worker
            if (!this.messageQueues.has(targetId)) {
              this.messageQueues.set(targetId, []);
            }
            this.messageQueues.get(targetId)!.push(rewrittenMessage);

            result.state.jobsAssigned++;

            // Track job assignment
            this.jobAssignments.set(jobId, {
              jobId,
              targetId: result.state.target.id,
              sessionId: result.state.sessionId!,
              assignedAt: new Date(),
            });

            // Queue target assignment for the worker that will be spawned
            this.pendingTargetAssignments.push(targetId);

            // Emit event to spawn worker for job messages only
            this.emit('job-received', result.state.target.id, jobId);
            this.emitStatusUpdate();
          } else if (isJobMessage) {
            log()?.debug(`[BrokerProxy] Job-like message without jobId (${messageType}) from ${result.state.target.displayName}`);
          } else {
            log()?.info(`[BrokerProxy] Message (${messageType}) received from ${result.state.target.displayName}`);
          }
        }
      }
      } finally {
        this.isPolling = false;
      }
    };

    // Poll immediately, then on interval
    poll();
    this.pollInterval = setInterval(poll, BrokerProxyService.POLL_INTERVAL_MS);
  }

  /**
   * Stop the polling loop.
   */
  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Stop the proxy server.
   */
  async stop(): Promise<void> {
    if (!this.isRunning || !this.server) return;

    // Signal shutdown to break out of long-polls immediately
    this.isShuttingDown = true;

    // Cancel any pending session retries
    this.cancelSessionRetries();

    // Stop polling first
    this.stopPolling();

    // Delete upstream sessions in background - don't wait during shutdown
    // Sessions will expire on their own if deletion fails
    for (const state of this.targets.values()) {
      this.deleteUpstreamSession(state).catch(() => {});
    }

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.isRunning = false;
        this.server = null;
        log()?.info('[BrokerProxy] Stopped');
        resolve();
      });
    });
  }

  /**
   * Get the next queued job, if any.
   * Workers call this to get a job to execute.
   */
  getQueuedJob(): { targetId: string; message: string } | null {
    for (const [targetId, queue] of this.messageQueues) {
      if (queue.length > 0) {
        return { targetId, message: queue.shift()! };
      }
    }
    return null;
  }

  /**
   * Check if there are queued jobs.
   */
  hasQueuedJobs(): boolean {
    for (const queue of this.messageQueues.values()) {
      if (queue.length > 0) return true;
    }
    return false;
  }

  /**
   * Get the port the proxy is listening on.
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get status for all targets.
   */
  getStatus(): RunnerProxyStatus[] {
    return Array.from(this.targets.values()).map(state => ({
      targetId: state.target.id,
      registered: true, // We have credentials, so registered
      sessionActive: !!state.sessionId,
      lastPoll: state.lastPoll?.toISOString() || null,
      jobsAssigned: state.jobsAssigned,
      error: state.error,
    }));
  }

  // --------------------------------------------------------------------------
  // OAuth Token Management
  // --------------------------------------------------------------------------

  private async getOAuthToken(state: TargetState): Promise<string> {
    // Check if we have a valid cached token (with 1 minute buffer)
    if (state.accessToken && state.tokenExpiry && Date.now() < state.tokenExpiry - 60000) {
      return state.accessToken;
    }

    const privateKey = buildPrivateKey(state.rsaParams);
    const jwt = createJWT(
      state.credentials.data.clientId,
      state.credentials.data.authorizationUrl,
      privateKey
    );

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: jwt,
    }).toString();

    const response = await httpsRequest(state.credentials.data.authorizationUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body).toString(),
      },
    }, body);

    if (response.statusCode !== 200) {
      throw new Error(`OAuth failed: ${response.statusCode} ${response.body}`);
    }

    const tokenData = JSON.parse(response.body);
    state.accessToken = tokenData.access_token;
    state.tokenExpiry = Date.now() + (tokenData.expires_in * 1000);

    log()?.debug( `[BrokerProxy] Got OAuth token for ${state.target.displayName}`);
    return state.accessToken!;
  }

  // --------------------------------------------------------------------------
  // Upstream Session Management
  // --------------------------------------------------------------------------

  private async createUpstreamSession(state: TargetState, retriesLeft = 3): Promise<string> {
    const token = await this.getOAuthToken(state);
    const brokerUrl = state.runner.serverUrlV2;

    log()?.debug(`[BrokerProxy] Creating session for ${state.target.displayName}`);

    const response = await httpsRequest(`${brokerUrl}session`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    }, '{}');

    // Handle 409 Conflict - session already exists
    if (response.statusCode === 409 && retriesLeft > 0) {
      log()?.info(`[BrokerProxy] Session conflict for ${state.target.displayName}, retries left: ${retriesLeft}`);
      log()?.debug(`[BrokerProxy] Conflict response: ${response.body}`);

      // Try to extract existing session ID from response
      let deletedSession = false;
      try {
        const conflictData = JSON.parse(response.body);
        if (conflictData.sessionId) {
          state.sessionId = conflictData.sessionId;
          await this.deleteUpstreamSession(state);
          deletedSession = true;
        }
      } catch {
        // Response might not have session ID
      }

      // Wait with exponential backoff: 2s, 4s, 8s
      const waitMs = deletedSession ? 1000 : 2000 * Math.pow(2, 3 - retriesLeft);
      log()?.info(`[BrokerProxy] Waiting ${waitMs}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));

      return this.createUpstreamSession(state, retriesLeft - 1);
    }

    if (response.statusCode !== 200 && response.statusCode !== 201) {
      throw new Error(`Session creation failed: ${response.statusCode} ${response.body}`);
    }

    const sessionData = JSON.parse(response.body);
    state.sessionId = sessionData.sessionId;
    state.error = undefined;

    log()?.info(`[BrokerProxy] Session created for ${state.target.displayName}`);
    this.emitStatusUpdate();

    return state.sessionId!;
  }

  private async deleteUpstreamSession(state: TargetState): Promise<void> {
    if (!state.sessionId) return;

    try {
      const token = await this.getOAuthToken(state);
      const brokerUrl = state.runner.serverUrlV2;

      await httpsRequest(`${brokerUrl}session?sessionId=${state.sessionId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      log()?.debug( `[BrokerProxy] Session deleted for ${state.target.displayName}`);
    } catch (error) {
      log()?.warn( `[BrokerProxy] Failed to delete session: ${(error as Error).message}`);
    } finally {
      state.sessionId = undefined;
      this.emitStatusUpdate();
    }
  }

  /**
   * Schedule a background retry for session creation.
   * This handles the case where GitHub has a stale session that takes ~90s to expire.
   */
  private scheduleSessionRetry(state: TargetState): void {
    const targetId = state.target.id;

    // Don't schedule if already scheduled or if we're shutting down
    if (this.sessionRetryTimeouts.has(targetId) || this.isShuttingDown) {
      return;
    }

    log()?.info(`[BrokerProxy] Scheduling session retry for ${state.target.displayName} in ${BrokerProxyService.SESSION_RETRY_INTERVAL_MS / 1000}s`);

    const timeout = setTimeout(async () => {
      this.sessionRetryTimeouts.delete(targetId);

      if (this.isShuttingDown || !this.isRunning) {
        return;
      }

      // Skip if session was already created (e.g., by another code path)
      if (state.sessionId) {
        log()?.debug(`[BrokerProxy] Session already exists for ${state.target.displayName}, skipping retry`);
        return;
      }

      log()?.info(`[BrokerProxy] Retrying session creation for ${state.target.displayName}...`);

      try {
        await this.createUpstreamSession(state);
        state.error = undefined;
        log()?.info(`[BrokerProxy] Session retry succeeded for ${state.target.displayName}`);
        this.emitStatusUpdate();
      } catch (error) {
        log()?.warn(`[BrokerProxy] Session retry failed for ${state.target.displayName}: ${(error as Error).message}`);
        state.error = (error as Error).message;
        this.emitStatusUpdate();
        // Schedule another retry
        this.scheduleSessionRetry(state);
      }
    }, BrokerProxyService.SESSION_RETRY_INTERVAL_MS);

    this.sessionRetryTimeouts.set(targetId, timeout);
  }

  /**
   * Cancel all pending session retries (called during shutdown).
   */
  private cancelSessionRetries(): void {
    for (const timeout of this.sessionRetryTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.sessionRetryTimeouts.clear();
  }

  private async pollUpstreamTarget(state: TargetState): Promise<{ hasMessage: boolean; body: string }> {
    if (!state.sessionId) {
      await this.createUpstreamSession(state);
    }

    const token = await this.getOAuthToken(state);
    const brokerUrl = state.runner.serverUrlV2;
    const pollUrl = `${brokerUrl}message?sessionId=${state.sessionId}&status=Online&runnerVersion=${this.runnerVersion}&os=darwin&architecture=arm64&disableUpdate=true`;

    try {
      const response = await httpsRequest(pollUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        },
      });

      state.lastPoll = new Date();
      const hadError = !!state.error;
      state.error = undefined;
      if (hadError) {
        this.emitStatusUpdate(); // Notify UI that error was cleared
      }

      // Log poll results for debugging
      if (response.statusCode === 200 && response.body) {
        log()?.info(`[BrokerProxy] Poll ${state.target.displayName}: got message (${response.body.length} bytes)`);
        return { hasMessage: true, body: response.body };
      }
      log()?.info(`[BrokerProxy] Poll ${state.target.displayName}: no message (status=${response.statusCode})`);
      return { hasMessage: false, body: '' };
    } catch (error) {
      const hadError = !!state.error;
      state.error = (error as Error).message;
      if (!hadError) {
        this.emitStatusUpdate(); // Notify UI of new error
      }
      this.emit('error', state.target.id, error);
      return { hasMessage: false, body: '' };
    }
  }

  /**
   * Acknowledge a message to GitHub so it won't be sent again.
   */
  private async acknowledgeMessageUpstream(state: TargetState, messageId: string): Promise<void> {
    try {
      const token = await this.getOAuthToken(state);
      const brokerUrl = state.runner.serverUrlV2;
      const ackUrl = `${brokerUrl}acknowledge?sessionId=${state.sessionId}`;

      const body = JSON.stringify({ messageId });

      log()?.debug(`[BrokerProxy] Acknowledging message ${messageId} to GitHub`);

      const response = await httpsRequest(ackUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      }, body);

      if (response.statusCode === 200) {
        log()?.debug(`[BrokerProxy] Acknowledged message ${messageId}`);
      } else {
        log()?.warn(`[BrokerProxy] Acknowledge returned ${response.statusCode}: ${response.body}`);
      }
    } catch (error) {
      log()?.warn(`[BrokerProxy] Failed to acknowledge message: ${(error as Error).message}`);
    }
  }

  /**
   * Acquire a job upstream on behalf of the worker.
   * This claims the job so GitHub won't return it on subsequent polls.
   * Must use run_service_url, not broker URL.
   */
  private async acquireJobUpstream(state: TargetState, jobId: string, runServiceUrl: string, billingOwnerId?: string): Promise<string | null> {
    const token = await this.getOAuthToken(state);
    const acquireUrl = `${runServiceUrl}acquirejob?sessionId=${state.sessionId}`;

    // GitHub expects jobMessageId (the runner_request_id UUID) as a string for acquiring jobs
    // Also include billingOwnerId and runnerOS as required by the API
    const runnerOS = 'macOS';  // Must match what runner sends
    const bodyObj: Record<string, string> = {
      jobMessageId: jobId,
      runnerOS,
    };
    if (billingOwnerId) {
      bodyObj.billingOwnerId = billingOwnerId;
    }
    const body = JSON.stringify(bodyObj);

    log()?.info(`[BrokerProxy] Acquiring job: POST ${acquireUrl} body=${body}`);

    try {
      const response = await httpsRequest(acquireUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      }, body);

      log()?.info(`[BrokerProxy] Acquire response: status=${response.statusCode}, body=${response.body.slice(0, 200)}`);

      if (response.statusCode === 200) {
        return response.body;
      }

      log()?.warn(`[BrokerProxy] acquirejob returned ${response.statusCode}: ${response.body}`);
      return null;
    } catch (error) {
      log()?.error(`[BrokerProxy] acquirejob error: ${(error as Error).message}`);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Request Handling
  // --------------------------------------------------------------------------

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    const method = req.method || 'GET';

    log()?.debug( `[BrokerProxy] ${method} ${url.pathname}`);

    try {
      if (method === 'POST' && url.pathname === '/session') {
        await this.handleSessionCreate(res);
      } else if (method === 'GET' && url.pathname === '/message') {
        await this.handleMessagePoll(res, url);
      } else if (method === 'DELETE' && url.pathname === '/session') {
        await this.handleSessionDelete(res, url);
      } else if (method === 'POST' && url.pathname === '/acknowledge') {
        // Handle acknowledge locally - the broker proxy already received the message
        // when it polled GitHub, so workers don't need to acknowledge upstream
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      } else if (method === 'POST' && url.pathname === '/acquirejob') {
        // Return stored job details - we already acquired the job from GitHub
        await this.handleAcquireJob(req, res);
      } else {
        // Forward all other requests (renewjob, finishjob, etc.)
        await this.handleForward(req, res, url);
      }
    } catch (error) {
      log()?.error( `[BrokerProxy] Error handling ${method} ${url.pathname}: ${(error as Error).message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
  }

  private async handleSessionCreate(res: http.ServerResponse): Promise<void> {
    const sessionId = crypto.randomUUID();

    // Assign this session to a target (from pending assignments queue)
    const targetId = this.pendingTargetAssignments.shift();
    log()?.debug(`[BrokerProxy] Creating local session ${sessionId} for target ${targetId || 'unknown'}`);

    // Only create upstream sessions if they don't already exist
    // (sessions are created on broker start, workers just reuse them)
    const enabledTargets = Array.from(this.targets.values())
      .filter(s => s.target.enabled && !s.sessionId);

    for (const state of enabledTargets) {
      try {
        await this.createUpstreamSession(state);
      } catch (error) {
        log()?.error(`[BrokerProxy] Failed to create upstream session for ${state.target.displayName}: ${(error as Error).message}`);
        state.error = (error as Error).message;
      }
    }

    this.localSessions.set(sessionId, {
      id: sessionId,
      createdAt: new Date(),
      targetId,  // Associate session with target
    });

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sessionId,
      ownerName: '',
      assignmentQueued: false,
      orchestrationId: '',
    }));
  }

  private async handleMessagePoll(res: http.ServerResponse, url: URL): Promise<void> {
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId || !this.localSessions.has(sessionId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    const session = this.localSessions.get(sessionId)!;
    const targetId = session.targetId;

    // If this worker already has a job, don't give them another one.
    // Workers run with --once so they should only get one job.
    if (session.currentJobId) {
      log()?.debug(`[BrokerProxy] Worker already has job ${session.currentJobId}, returning empty`);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('');
      return;
    }

    // Helper to get a message for this session's target
    const getMessageForTarget = (): string | undefined => {
      if (!targetId) {
        // No target assigned - this worker was scaled up preemptively or recycled
        // without a job. It should NOT steal messages from target-specific queues.
        // Only workers spawned for specific jobs should receive messages.
        return undefined;
      }
      const queue = this.messageQueues.get(targetId);
      return queue?.shift();
    };

    // Helper to extract job ID from message and mark session
    const markSessionWithJob = (message: string): void => {
      try {
        const parsed = JSON.parse(message);
        let innerBody = parsed.body;
        if (typeof innerBody === 'string') {
          innerBody = JSON.parse(innerBody);
        }
        const jobId = innerBody?.jobId || innerBody?.runner_request_id;
        if (jobId) {
          session.currentJobId = jobId;
          log()?.debug(`[BrokerProxy] Marked session ${sessionId} with job ${jobId}`);
        }
      } catch {
        // Could not parse, still deliver the message
      }
    };

    // Check queue first (messages are queued by active polling)
    const message = getMessageForTarget();
    if (message) {
      markSessionWithJob(message);
      log()?.info(`[BrokerProxy] Returning message to worker (target: ${targetId})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(message);
      return;
    }

    // Long-polling with exponential backoff: wait for a message to arrive
    const LONG_POLL_TIMEOUT_MS = 50000;  // 50 seconds (just under typical HTTP timeout)
    const INITIAL_CHECK_INTERVAL_MS = 100;
    const MAX_CHECK_INTERVAL_MS = 5000;
    const BACKOFF_MULTIPLIER = 1.5;

    const startTime = Date.now();
    let checkInterval = INITIAL_CHECK_INTERVAL_MS;

    const checkForMessage = (): Promise<void> => {
      return new Promise((resolve) => {
        const check = () => {
          // Check if shutting down - return empty response immediately
          if (this.isShuttingDown) {
            if (!res.writableEnded) {
              res.writeHead(202, { 'Content-Type': 'application/json' });
              res.end('');
            }
            resolve();
            return;
          }

          // Check if response is already closed
          if (res.writableEnded) {
            resolve();
            return;
          }

          // Check for a message for this target
          const msg = getMessageForTarget();
          if (msg) {
            markSessionWithJob(msg);
            log()?.info(`[BrokerProxy] Returning message to worker (long-poll, target: ${targetId})`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(msg);
            resolve();
            return;
          }

          // Check if timeout reached
          if (Date.now() - startTime >= LONG_POLL_TIMEOUT_MS) {
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end('');
            resolve();
            return;
          }

          // Exponential backoff: increase interval up to max
          checkInterval = Math.min(checkInterval * BACKOFF_MULTIPLIER, MAX_CHECK_INTERVAL_MS);
          setTimeout(check, checkInterval);
        };

        check();
      });
    };

    await checkForMessage();
  }

  private async handleSessionDelete(res: http.ServerResponse, url: URL): Promise<void> {
    const sessionId = url.searchParams.get('sessionId');
    if (sessionId) {
      this.localSessions.delete(sessionId);
    }
    res.writeHead(200);
    res.end();
  }

  /**
   * Handle acquirejob requests from workers.
   * We already acquired the job from GitHub when we received the job message,
   * so we just return the stored job details.
   */
  private async handleAcquireJob(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Read request body to get job ID
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString();

    // Parse body to find job ID
    let jobId: string | undefined;
    try {
      const bodyJson = JSON.parse(body);
      log()?.info(`[BrokerProxy] acquirejob request body: ${JSON.stringify(bodyJson)}`);
      // Runner uses jobMessageId (which is the message.messageId from the broker)
      jobId = bodyJson.jobMessageId || bodyJson.jobRequestId || bodyJson.requestId;
    } catch (e) {
      log()?.warn(`[BrokerProxy] Could not parse acquirejob body: ${body}`);
    }

    if (!jobId) {
      log()?.warn(`[BrokerProxy] acquirejob: no job ID found in request`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No job ID in request' }));
      return;
    }

    // Look up stored job details
    let jobDetails = this.acquiredJobDetails.get(jobId);
    if (jobDetails) {
      // Rewrite run_service_url in the response to point to our proxy
      // This ensures all subsequent job operations go through us
      try {
        const parsed = JSON.parse(jobDetails);
        log()?.info(`[BrokerProxy] acquirejob response keys: ${Object.keys(parsed).join(', ')}`);
        // Check various possible field names
        const urlField = parsed.runServiceUrl || parsed.run_service_url || parsed.runnerServiceUrl;
        if (urlField) {
          const proxyUrl = `http://localhost:${this.port}/`;
          log()?.info(`[BrokerProxy] Rewriting runServiceUrl in acquirejob response: ${urlField} -> ${proxyUrl}`);
          if (parsed.runServiceUrl) parsed.runServiceUrl = proxyUrl;
          if (parsed.run_service_url) parsed.run_service_url = proxyUrl;
          if (parsed.runnerServiceUrl) parsed.runnerServiceUrl = proxyUrl;
          jobDetails = JSON.stringify(parsed);
        } else {
          log()?.info(`[BrokerProxy] No runServiceUrl field found in acquirejob response`);
        }
      } catch (e) {
        log()?.warn(`[BrokerProxy] Could not rewrite runServiceUrl in acquirejob response: ${(e as Error).message}`);
      }
      log()?.info(`[BrokerProxy] acquirejob: returning stored details for ${jobId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(jobDetails);
    } else {
      log()?.warn(`[BrokerProxy] acquirejob: no stored details for ${jobId}`);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Job not found' }));
    }
  }

  private async handleForward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    // Determine which target to forward to based on local session ID
    const localSessionId = url.searchParams.get('sessionId');
    let targetState: TargetState | undefined;

    // Look up local session to find associated target
    if (localSessionId) {
      const localSession = this.localSessions.get(localSessionId);
      if (localSession?.targetId) {
        targetState = this.targets.get(localSession.targetId);
      }
    }

    // Fallback to first enabled target with an active upstream session
    if (!targetState) {
      targetState = Array.from(this.targets.values())
        .find(s => s.target.enabled && s.sessionId);
    }

    if (!targetState || !targetState.sessionId) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No active target sessions' }));
      return;
    }

    log()?.info(`[BrokerProxy] Forward using target ${targetState.target.displayName}, upstream sessionId=${targetState.sessionId}`);

    // Read request body first (needed for routing decisions)
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString();

    // Replace local session ID with upstream session ID in query params
    const upstreamParams = new URLSearchParams(url.search);
    if (localSessionId) {
      upstreamParams.set('sessionId', targetState.sessionId);
    }

    const token = await this.getOAuthToken(targetState);

    // Determine upstream URL - job operations go to run_service_url, others to broker
    let upstreamUrl: string;

    // For job operations, try to use the run_service_url from the job message
    // Note: /acknowledge goes to broker, NOT run_service_url (it's BrokerHttpClient.AcknowledgeRunnerRequestAsync)
    const jobOperations = ['/acquirejob', '/renewjob', '/finishjob', '/jobrequest'];
    if (jobOperations.some(op => url.pathname.startsWith(op))) {
      // Try to find run_service_url from request body or stored job info
      let runServiceUrl: string | undefined;
      try {
        const bodyJson = JSON.parse(body);
        log()?.info(`[BrokerProxy] Job operation ${url.pathname} body: ${JSON.stringify(bodyJson)}`);
        // Try multiple ID fields - runner uses different ones for different operations
        const jobId = bodyJson.jobRequestId || bodyJson.requestId || bodyJson.runnerRequestId
          || bodyJson.runner_request_id || bodyJson.jobMessageId;
        log()?.debug(`[BrokerProxy] Looking for run_service_url with jobId: ${jobId}`);
        if (jobId) {
          runServiceUrl = this.jobRunServiceUrls.get(jobId);
          log()?.info(`[BrokerProxy] Found run_service_url for ${jobId}: ${runServiceUrl || 'not found'}`);
        }
      } catch (e) {
        log()?.info(`[BrokerProxy] Could not parse job operation body: ${(e as Error).message}, body: ${body?.slice(0, 100)}`);
      }

      if (runServiceUrl) {
        upstreamUrl = `${runServiceUrl}${url.pathname}?${upstreamParams.toString()}`;
        log()?.info(`[BrokerProxy] Forward ${req.method} ${url.pathname} -> run_service_url`);
      } else {
        upstreamUrl = `${targetState.runner.serverUrlV2}${url.pathname.slice(1)}?${upstreamParams.toString()}`;
        log()?.info(`[BrokerProxy] Forward ${req.method} ${url.pathname} -> broker (no run_service_url found)`);
      }
    } else {
      upstreamUrl = `${targetState.runner.serverUrlV2}${url.pathname.slice(1)}?${upstreamParams.toString()}`;
      log()?.debug(`[BrokerProxy] Forward ${req.method} ${url.pathname} -> broker`);
    }

    const response = await httpsRequest(upstreamUrl, {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    }, body || undefined);

    res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
    res.end(response.body);
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private emitStatusUpdate(): void {
    this.emit('status-update', this.getStatus());
  }
}
