#!/usr/bin/env node
/**
 * localmost CLI companion
 *
 * Commands:
 *   localmost start   - Start the localmost app
 *   localmost stop    - Stop the localmost app
 *   localmost status  - Show runner status
 *   localmost pause   - Pause the runner
 *   localmost resume  - Resume the runner
 *   localmost jobs    - Show recent job history
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { getCliSocketPath, getAppDataDirWithoutElectron } from '../shared/paths';

interface CliRequest {
  command: 'status' | 'pause' | 'resume' | 'jobs' | 'quit';
}

interface RunnerState {
  status: 'idle' | 'starting' | 'running' | 'busy' | 'offline' | 'error';
  jobName?: string;
  repository?: string;
  startedAt?: string;
}

interface JobHistoryEntry {
  id: string;
  jobName: string;
  repository: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  runTimeSeconds?: number;
  actionsUrl?: string;
}

interface ResourcePauseState {
  isPaused: boolean;
  reason: string | null;
}

interface StatusResponse {
  success: true;
  command: 'status';
  data: {
    runner: RunnerState;
    runnerName: string;
    heartbeat: { isRunning: boolean };
    authenticated: boolean;
    userName?: string;
    resourcePause?: ResourcePauseState;
  };
}

interface JobsResponse {
  success: true;
  command: 'jobs';
  data: { jobs: JobHistoryEntry[] };
}

interface ActionResponse {
  success: true;
  command: 'pause' | 'resume' | 'quit';
  message: string;
}

interface ErrorResponse {
  success: false;
  error: string;
}

type CliResponse = StatusResponse | JobsResponse | ActionResponse | ErrorResponse;

const HELP_TEXT = `
localmost - CLI companion for localmost app

USAGE:
  localmost <command>

COMMANDS:
  start     Start the localmost app
  stop      Stop the localmost app
  status    Show current runner status
  pause     Pause the runner (stops accepting jobs)
  resume    Resume the runner (start accepting jobs)
  jobs      Show recent job history
  help      Show this help message

EXAMPLES:
  localmost start
  localmost status
  localmost pause
  localmost stop

NOTE:
  Most commands require the localmost app to be running.
  Use 'localmost start' to launch the app first.
`;

function printHelp(): void {
  console.log(HELP_TEXT.trim());
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString();
}

function getStatusIcon(status: string): string {
  switch (status) {
    case 'running': return '\u2713'; // checkmark
    case 'busy': return '\u25CF';    // filled circle
    case 'starting': return '\u25CB'; // empty circle
    case 'idle': return '\u25CB';    // empty circle
    case 'offline': return '\u25CB'; // empty circle
    case 'error': return '\u2717';   // x mark
    case 'completed': return '\u2713';
    case 'failed': return '\u2717';
    case 'cancelled': return '-';
    default: return '?';
  }
}

function printStatus(response: StatusResponse): void {
  const { runner, runnerName, heartbeat, authenticated, userName, resourcePause } = response.data;

  console.log(`\nRunner: ${runnerName}`);

  // Check for resource pause first
  if (resourcePause?.isPaused && runner.status === 'offline') {
    console.log(`Status: \u23F8 Paused (${resourcePause.reason || 'resource constraint'})`);
    console.log(`        Will resume when condition clears`);
  } else {
    console.log(`Status: ${getStatusIcon(runner.status)} ${runner.status}`);

    if (runner.status === 'busy' && runner.jobName) {
      console.log(`Job:    ${runner.jobName}`);
    }
  }

  if (runner.startedAt) {
    console.log(`Uptime: started ${formatTimestamp(runner.startedAt)}`);
  }

  console.log(`\nHeartbeat: ${heartbeat.isRunning ? 'active' : 'inactive'}`);

  if (authenticated) {
    console.log(`GitHub:    authenticated as ${userName || 'unknown'}`);
  } else {
    console.log(`GitHub:    not authenticated`);
  }

  console.log();
}

function printJobs(response: JobsResponse): void {
  const { jobs } = response.data;

  if (jobs.length === 0) {
    console.log('\nNo recent jobs.\n');
    return;
  }

  console.log(`\nRecent jobs (${jobs.length}):\n`);

  // Print in reverse order (most recent first)
  const sortedJobs = [...jobs].reverse();

  for (const job of sortedJobs) {
    const icon = getStatusIcon(job.status);
    const duration = job.runTimeSeconds ? formatDuration(job.runTimeSeconds) : '-';
    const time = formatTimestamp(job.startedAt);

    console.log(`  ${icon} ${job.jobName}`);
    console.log(`    Status:   ${job.status}`);
    console.log(`    Duration: ${duration}`);
    console.log(`    Started:  ${time}`);
    if (job.actionsUrl) {
      console.log(`    URL:      ${job.actionsUrl}`);
    }
    console.log();
  }
}

async function sendCommand(command: CliRequest['command']): Promise<CliResponse> {
  const socketPath = getCliSocketPath();

  if (!fs.existsSync(socketPath)) {
    throw new Error('localmost app is not running (socket not found)');
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => {
      const request: CliRequest = { command };
      socket.write(JSON.stringify(request) + '\n');
    });

    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            const response = JSON.parse(line) as CliResponse;
            socket.end();
            resolve(response);
            return;
          } catch {
            // Not complete JSON yet
          }
        }
      }
    });

    socket.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        reject(new Error('localmost app is not running (connection refused)'));
      } else if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('localmost app is not running (socket not found)'));
      } else {
        reject(err);
      }
    });

    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error('Connection timed out'));
    });
  });
}

/**
 * Check if the app is running by testing socket connection.
 */
function isAppRunning(): boolean {
  const socketPath = getCliSocketPath();
  return fs.existsSync(socketPath);
}

/**
 * Find the localmost app bundle path.
 * Checks standard macOS installation locations.
 */
function findAppPath(): string | null {
  const possiblePaths = [
    '/Applications/localmost.app',
    path.join(process.env.HOME || '', 'Applications', 'localmost.app'),
    // Development build location
    path.join(__dirname, '..', '..', 'out', 'localmost-darwin-arm64', 'localmost.app'),
    path.join(__dirname, '..', '..', 'out', 'localmost-darwin-x64', 'localmost.app'),
  ];

  for (const appPath of possiblePaths) {
    if (fs.existsSync(appPath)) {
      return appPath;
    }
  }

  return null;
}

/**
 * Start the localmost app.
 */
async function startApp(): Promise<void> {
  if (isAppRunning()) {
    console.log('localmost is already running');
    return;
  }

  const appPath = findAppPath();

  if (!appPath) {
    console.error('Error: Could not find localmost.app');
    console.error('Please install localmost to /Applications or ~/Applications');
    process.exit(1);
  }

  console.log('Starting localmost...');

  // Use 'open' command on macOS to launch the app
  const child = spawn('open', ['-a', appPath], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  // Wait for the app to start (up to 10 seconds)
  const maxWait = 10000;
  const checkInterval = 500;
  let waited = 0;

  while (waited < maxWait) {
    await new Promise((resolve) => setTimeout(resolve, checkInterval));
    waited += checkInterval;

    if (isAppRunning()) {
      console.log('localmost started successfully');
      return;
    }
  }

  console.log('localmost is starting... (check the menu bar for the icon)');
}

/**
 * Stop the localmost app.
 */
async function stopApp(): Promise<void> {
  if (!isAppRunning()) {
    console.log('localmost is not running');
    return;
  }

  try {
    const response = await sendCommand('quit');

    if (!response.success) {
      console.error(`Error: ${response.error}`);
      process.exit(1);
    }

    console.log((response as ActionResponse).message);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  const command = args[0];

  // Handle start command separately (doesn't need socket)
  if (command === 'start') {
    await startApp();
    process.exit(0);
  }

  // Handle stop command
  if (command === 'stop') {
    await stopApp();
    process.exit(0);
  }

  if (!['status', 'pause', 'resume', 'jobs'].includes(command)) {
    console.error(`Unknown command: ${command}`);
    console.error('Run "localmost help" for usage information.');
    process.exit(1);
  }

  try {
    const response = await sendCommand(command as CliRequest['command']);

    if (!response.success) {
      console.error(`Error: ${response.error}`);
      process.exit(1);
    }

    switch (response.command) {
      case 'status':
        printStatus(response as StatusResponse);
        break;
      case 'jobs':
        printJobs(response as JobsResponse);
        break;
      case 'pause':
      case 'resume':
        console.log((response as ActionResponse).message);
        break;
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
