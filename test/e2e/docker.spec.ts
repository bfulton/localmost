/**
 * A real docker CLI, a real daemon, and the filtering socket between them.
 *
 * The unit tests prove what the filter decides, against a fake daemon. They
 * cannot prove that a real job works through it: that the CLI negotiates
 * down to the pinned API version, that a create body passes the host-config
 * gates with the zero values the CLI actually sends, that an attach upgrade
 * and a wait relay end to end, and that a refusal reaches the CLI as an
 * error it prints. So this runs the commands a workflow step would run, with
 * DOCKER_HOST pointed at a socket served the way RunnerManager serves one:
 * at the root of the sandbox directory, bound on claim to the repository's
 * policy, forwarding to the operator's daemon through the desktop backend.
 *
 * This suite never skips. A missing daemon or CLI is a failure that names
 * what to install: the answer to "no Docker here" is to provision Docker
 * where the tests run, not to let the suite report green having run nothing.
 */

import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DesktopBackend } from '../../src/main/docker/docker-backend';
import { DockerFilterProxy, DockerFilterProxyLogEntry } from '../../src/main/docker/docker-filter-proxy';
import { resolveDockerEndpoint } from '../../src/shared/docker-access';
import { DockerPolicy } from '../../src/shared/docker-policy';

const IMAGE = 'alpine:3';

/** What a repository using Docker would declare: one image, the workspace read-only, the default network. */
const policy: DockerPolicy = {
  pull: { registries: ['docker.io'] },
  run: { images: [IMAGE], mounts: [{ path: './', mode: 'ro' }], network: 'bridge' },
};

const endpoint = resolveDockerEndpoint();

/** The docker CLI a job would run, found on PATH the way the job's shell finds it. */
const findDockerCli = (): string | undefined => {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'docker');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
};
const dockerCli = findDockerCli();

/** What is missing to run this for real, if anything. Reported as a failure, never a skip. */
const missingReason = !endpoint
  ? 'no Docker daemon: resolveDockerEndpoint() found no daemon socket. Install and start Docker where these tests run.'
  : !dockerCli
    ? 'no docker CLI on PATH to drive the socket with. Install Docker where these tests run.'
    : null;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

test.describe('a job using docker through the filtering socket', () => {
  // First, and never skipped: the suite runs against real Docker or it fails
  // saying what to install. A green run here means a real job actually worked.
  test('has a real Docker daemon and CLI to drive, rather than skipping', () => {
    expect(missingReason, missingReason ?? '').toBeNull();
  });

  const backend = new DesktopBackend();
  const logs: DockerFilterProxyLogEntry[] = [];
  let proxy: DockerFilterProxy;
  let sandboxDir: string;
  let workspace: string;
  let env: NodeJS.ProcessEnv;
  const nonce = `hello-${process.pid}-${Date.now()}`;

  test.beforeAll(async () => {
    // Fail here with the real reason, so the tests below do not each fail on
    // a confusing consequence (a proxy with no endpoint, a spawn of no CLI).
    if (missingReason) throw new Error(missingReason);

    // Short prefix: the socket path is capped at 104 bytes and tmpdir is long.
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-e2e-'));
    // The checkout dir the backend roots mounts at, resolved as the daemon
    // sees it: tmpdir is under /var, a symlink.
    const workDir = backend.workspaceMountRoot(sandboxDir);
    fs.mkdirSync(workDir);
    workspace = fs.realpathSync.native(workDir);
    fs.writeFileSync(path.join(workspace, 'hello.txt'), `${nonce}\n`);

    const socketPath = path.join(sandboxDir, 'docker.sock');
    proxy = new DockerFilterProxy({ backend, onLog: (entry) => logs.push(entry) });
    await proxy.start(socketPath);
    proxy.bind('owner/repo', policy);

    // The job's environment: the served socket, and a docker config of its
    // own so the operator's contexts and credential helpers play no part.
    const dockerConfig = path.join(sandboxDir, 'docker-config');
    fs.mkdirSync(dockerConfig);
    env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DOCKER_HOST: `unix://${socketPath}`,
      DOCKER_CONFIG: dockerConfig,
      DOCKER_CLI_HINTS: 'false',
    };
  });

  test.afterAll(async () => {
    await proxy?.stop();
    if (sandboxDir) fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  /** Run the docker CLI as the job, reporting the exit code rather than throwing on it. */
  const docker = (...args: string[]): Promise<Run> =>
    new Promise((resolve, reject) => {
      const child = spawn(dockerCli!, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

  /** The socket's log entries since a point in the test. */
  const logsSince = (mark: number): DockerFilterProxyLogEntry[] => logs.slice(mark);

  test('pulls the declared image and runs it with the declared read-only workspace mount', async () => {
    const mark = logs.length;

    const pull = await docker('pull', IMAGE);
    expect(pull.code, pull.stderr).toBe(0);

    const run = await docker('run', '--rm', '-v', `${workspace}:/ws:ro`, IMAGE, 'cat', '/ws/hello.txt');
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(nonce);

    // Both went through the filter, and nothing on the way was refused.
    const since = logsSince(mark);
    expect(since.some((l) => /forwarded POST \/images\/create/.test(l.message))).toBe(true);
    expect(since.some((l) => /forwarded POST \/containers\/create/.test(l.message))).toBe(true);
    expect(since.filter((l) => /^(denied|refused) /.test(l.message))).toEqual([]);
  });

  test('refuses a bind outside the workspace, and the container never runs', async () => {
    // Stands in for ~/.ssh: a real directory, outside the job workspace.
    const outside = path.join(sandboxDir, 'home', '.ssh');
    fs.mkdirSync(outside, { recursive: true });
    const mark = logs.length;

    const run = await docker('run', '--rm', '-v', `${outside}:/host-ssh`, IMAGE, 'ls', '/host-ssh');

    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/outside the job workspace/);
    const since = logsSince(mark);
    expect(since.some((l) => /denied POST \/containers\/create/.test(l.message))).toBe(true);
    expect(since.some((l) => /forwarded POST \/containers\/create/.test(l.message))).toBe(false);
  });

  test('refuses a writable mount of the workspace declared read-only, naming the policy that would permit it', async () => {
    const mark = logs.length;

    const run = await docker('run', '--rm', '-v', `${workspace}:/ws`, IMAGE, 'true');

    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/not declared in the repository docker policy \(run\.mounts\)/);
    const denial = logsSince(mark).find((l) => l.policyHint !== undefined);
    expect(denial?.policyHint).toMatch(/path: "\.\/"\n\s*mode: rw/);
  });
});
