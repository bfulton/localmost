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
  private runnerVersion = '2.330.0';

  constructor(port = 8787) {
    super();
    this.port = port;
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
   * Start the proxy server.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    return new Promise((resolve, reject) => {
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
  }

  /**
   * Stop the proxy server.
   */
  async stop(): Promise<void> {
    if (!this.isRunning || !this.server) return;

    // Delete all upstream sessions
    const deletePromises = Array.from(this.targets.values()).map(
      state => this.deleteUpstreamSession(state).catch(() => {})
    );
    await Promise.all(deletePromises);

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.isRunning = false;
        this.server = null;
        log()?.info( '[BrokerProxy] Stopped');
        resolve();
      });
    });
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

  private async createUpstreamSession(state: TargetState): Promise<string> {
    const token = await this.getOAuthToken(state);
    const brokerUrl = state.runner.serverUrlV2;

    log()?.debug( `[BrokerProxy] Creating session for ${state.target.displayName}`);

    const response = await httpsRequest(`${brokerUrl}session`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    }, '{}');

    if (response.statusCode !== 200 && response.statusCode !== 201) {
      throw new Error(`Session creation failed: ${response.statusCode} ${response.body}`);
    }

    const sessionData = JSON.parse(response.body);
    state.sessionId = sessionData.sessionId;
    state.error = undefined;

    log()?.info( `[BrokerProxy] Session created for ${state.target.displayName}`);
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
      state.error = undefined;

      if (response.statusCode === 200 && response.body) {
        return { hasMessage: true, body: response.body };
      }
      return { hasMessage: false, body: '' };
    } catch (error) {
      state.error = (error as Error).message;
      this.emit('error', state.target.id, error);
      return { hasMessage: false, body: '' };
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
      } else {
        // Forward all other requests (acquirejob, renewjob, acknowledge, etc.)
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
    log()?.debug( `[BrokerProxy] Creating local session ${sessionId}`);

    // Create upstream sessions for all enabled targets
    const enabledTargets = Array.from(this.targets.values())
      .filter(s => s.target.enabled);

    for (const state of enabledTargets) {
      try {
        await this.createUpstreamSession(state);
      } catch (error) {
        log()?.error( `[BrokerProxy] Failed to create upstream session for ${state.target.displayName}: ${(error as Error).message}`);
        state.error = (error as Error).message;
      }
    }

    this.localSessions.set(sessionId, {
      id: sessionId,
      createdAt: new Date(),
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

    const enabledTargets = Array.from(this.targets.values())
      .filter(s => s.target.enabled && s.sessionId);

    if (enabledTargets.length === 0) {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('');
      return;
    }

    // Poll all targets concurrently
    const pollPromises = enabledTargets.map(async (state) => {
      const result = await this.pollUpstreamTarget(state);
      return { state, ...result };
    });

    const results = await Promise.all(pollPromises);

    for (const result of results) {
      if (result.hasMessage) {
        log()?.info( `[BrokerProxy] Job received from ${result.state.target.displayName}`);
        result.state.jobsAssigned++;

        // Parse job info if possible
        try {
          const message = JSON.parse(result.body);
          if (message.body?.jobId) {
            this.jobAssignments.set(message.body.jobId, {
              jobId: message.body.jobId,
              targetId: result.state.target.id,
              sessionId: result.state.sessionId!,
              assignedAt: new Date(),
            });
            this.emit('job-received', result.state.target.id, message.body.jobId);
          }
        } catch {
          // Not JSON or no jobId, that's fine
        }

        this.emitStatusUpdate();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(result.body);
        return;
      }
    }

    // No messages from any target
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end('');
  }

  private async handleSessionDelete(res: http.ServerResponse, url: URL): Promise<void> {
    const sessionId = url.searchParams.get('sessionId');
    if (sessionId) {
      this.localSessions.delete(sessionId);
    }
    res.writeHead(200);
    res.end();
  }

  private async handleForward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    // Determine which target to forward to based on session ID in query params
    const sessionId = url.searchParams.get('sessionId');
    let targetState: TargetState | undefined;

    // Find target by session ID
    if (sessionId) {
      targetState = Array.from(this.targets.values())
        .find(s => s.sessionId === sessionId);
    }

    // Fallback to first enabled target
    if (!targetState) {
      targetState = Array.from(this.targets.values())
        .find(s => s.target.enabled && s.sessionId);
    }

    if (!targetState) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No active target sessions' }));
      return;
    }

    const token = await this.getOAuthToken(targetState);
    const upstreamUrl = `${targetState.runner.serverUrlV2}${url.pathname.slice(1)}${url.search}`;

    // Read request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString();

    log()?.debug( `[BrokerProxy] Forward ${req.method} -> ${targetState.target.displayName}`);

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
