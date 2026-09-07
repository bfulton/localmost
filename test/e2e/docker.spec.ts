/**
 * A real docker CLI, a real daemon, and the filtering socket between them.
 *
 * The unit tests prove what the filter decides, against a fake daemon. They
 * cannot prove that a real job works through it: that the CLI negotiates
 * down to the pinned API version, that a create body passes the host-config
 * gates with the zero values the CLI actually sends, that an attach upgrade
 * and a wait relay end to end, and that a refusal reaches the CLI as an
 * error it prints. So this runs the commands a workflow step would run.
 *
 * It reaches a real filter one of two ways, so it runs on every leg and never
 * skips:
 *
 *   Outside a job (a developer machine, a GitHub-hosted runner): this file
 *   serves the socket itself, the way RunnerManager does - at the root of a
 *   sandbox directory, bound on claim to the policy, forwarding to the
 *   operator's daemon through the desktop backend - and asserts on the
 *   proxy's own log as well as on the CLI.
 *
 *   Inside a localmost job: the runner already serves the job a filtering
 *   socket bound to this repository's approved .localmostrc, and DOCKER_HOST
 *   names it. Driving that socket exercises the production proxy rather than
 *   one this file built. The CLI's exit codes and output carry the proof
 *   there, since the production proxy's log is not this process's to read.
 *
 * A missing daemon (outside) or served socket (inside) is a failure naming
 * what to provision. Never a skip, never a fake: the point is the real thing.
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

/** The repository this socket is bound to; the checkout layout follows from it. */
const REPOSITORY = 'owner/repo';

/**
 * What a repository using Docker declares: one image, the workspace read-only,
 * the default network. Outside a job this file binds it; inside a job the
 * runner has bound this repository's own .localmostrc, which declares the same.
 */
const policy: DockerPolicy = {
  pull: { registries: ['docker.io'] },
  run: {
    images: [IMAGE],
    mounts: [{ path: './', mode: 'ro' }],
    network: 'bridge',
    networks: [{ name: 'localmost-e2e-*', internal: true }],
  },
};

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

// Inside a localmost job, DOCKER_HOST names a socket the runner serves the job,
// never the daemon itself; GITHUB_ACTIONS marks a job, as opposed to a
// developer shell that happens to export DOCKER_HOST.
const dockerHost = process.env.DOCKER_HOST;
const servedSocket = dockerHost?.startsWith('unix://') ? dockerHost.slice('unix://'.length) : undefined;
const daemonPaths = ['/var/run/docker.sock', path.join(os.homedir(), '.docker', 'run', 'docker.sock')];
const insideJob =
  process.env.GITHUB_ACTIONS === 'true' && servedSocket !== undefined && !daemonPaths.includes(servedSocket);

const endpoint = insideJob ? null : resolveDockerEndpoint();

/** What is missing to run this for real, if anything. Reported as a failure, never a skip. */
const missingReason = !dockerCli
  ? 'no docker CLI on PATH to drive the socket with. Install Docker where these tests run.'
  : insideJob
    ? fs.existsSync(servedSocket!)
      ? null
      : `DOCKER_HOST names ${servedSocket}, but nothing is served there. The runner serves a job its docker socket only once the repository's docker policy is approved.`
    : endpoint
      ? null
      : 'no Docker daemon: resolveDockerEndpoint() found no daemon socket. Install and start Docker where these tests run.';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

test.describe('a job using docker through the filtering socket', () => {
  // First, and never skipped: the suite runs against real Docker or it fails
  // saying what to provision. A green run here means a real job actually worked.
  test('has a real Docker daemon and CLI to drive, rather than skipping', () => {
    expect(missingReason, missingReason ?? '').toBeNull();
  });

  /** Set only when this file serves the socket; the production proxy's log is not readable from a job. */
  let logs: DockerFilterProxyLogEntry[] | undefined;
  let proxy: DockerFilterProxy | undefined;
  let scratch: string;
  let jobWorkspace: string | undefined;
  let workspace: string;
  let env: NodeJS.ProcessEnv;
  const nonce = `hello-${process.pid}-${Date.now()}`;
  const network = `localmost-e2e-${process.pid}`;

  // A real directory outside any workspace, so the refusal is "outside the job
  // workspace" rather than "cannot be resolved". Stands in for ~/.ssh.
  const outside = '/etc';

  test.beforeAll(async () => {
    // Fail here with the real reason, so the tests below do not each fail on
    // a confusing consequence (a proxy with no endpoint, a spawn of no CLI).
    if (missingReason) throw new Error(missingReason);

    // Short prefix: a socket path is capped at 104 bytes and tmpdir is long.
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-e2e-'));

    let socketPath: string;
    if (insideJob) {
      socketPath = servedSocket!;
      // Inside the job's own checkout, which the production proxy roots mounts
      // at; a declared "./" permits any path below it, at or below its mode.
      jobWorkspace = fs.mkdtempSync(path.join(process.cwd(), '.docker-e2e-'));
      workspace = fs.realpathSync.native(jobWorkspace);
    } else {
      const backend = new DesktopBackend();
      // The checkout the backend roots mounts at, for the repository this
      // socket is bound to below: the runner lays it out as
      // _work/<repo>/<repo>, and declared paths resolve against it. Resolved
      // as the daemon sees it, since tmpdir is under /var, a symlink.
      const workDir = backend.workspaceMountRoot(scratch, REPOSITORY);
      fs.mkdirSync(workDir, { recursive: true });
      workspace = fs.realpathSync.native(workDir);

      socketPath = path.join(scratch, 'docker.sock');
      const captured: DockerFilterProxyLogEntry[] = [];
      logs = captured;
      proxy = new DockerFilterProxy({ backend, onLog: (entry) => captured.push(entry) });
      await proxy.start(socketPath);
      proxy.bind(REPOSITORY, policy);
    }
    fs.writeFileSync(path.join(workspace, 'hello.txt'), `${nonce}\n`);

    // The job's environment: the served socket, and a docker config of its
    // own so the operator's contexts and credential helpers play no part.
    const dockerConfig = path.join(scratch, 'docker-config');
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
    // Before the proxy stops, and tolerant of a test that already removed it.
    if (env) await docker('network', 'rm', network).catch(() => undefined);
    await proxy?.stop();
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    if (jobWorkspace) fs.rmSync(jobWorkspace, { recursive: true, force: true });
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

  /** The socket's log entries since a point in the test, when this file serves it. */
  const mark = (): number => logs?.length ?? 0;
  const logsSince = (at: number): DockerFilterProxyLogEntry[] => (logs ?? []).slice(at);

  test('pulls the declared image and runs it with the declared read-only workspace mount', async () => {
    const at = mark();

    const pull = await docker('pull', IMAGE);
    expect(pull.code, pull.stderr).toBe(0);

    const run = await docker('run', '--rm', '-v', `${workspace}:/ws:ro`, IMAGE, 'cat', '/ws/hello.txt');
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(nonce);

    // When this file serves the socket, its log shows both went through the
    // filter and nothing on the way was refused. Inside a job the exit codes
    // and the nonce above are the proof: nothing reaches the daemon except
    // through the runner's filter.
    if (logs) {
      const since = logsSince(at);
      expect(since.some((l) => /forwarded POST \/images\/create/.test(l.message))).toBe(true);
      expect(since.some((l) => /forwarded POST \/containers\/create/.test(l.message))).toBe(true);
      expect(since.filter((l) => /^(denied|refused) /.test(l.message))).toEqual([]);
    }
  });

  test('refuses a bind outside the workspace, and the container never runs', async () => {
    const at = mark();

    const run = await docker('run', '--rm', '-v', `${outside}:/host-ssh`, IMAGE, 'ls', '/host-ssh');

    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/outside the job workspace/);
    if (logs) {
      const since = logsSince(at);
      expect(since.some((l) => /denied POST \/containers\/create/.test(l.message))).toBe(true);
      expect(since.some((l) => /forwarded POST \/containers\/create/.test(l.message))).toBe(false);
    }
  });

  test('refuses a writable mount of the workspace declared read-only, naming the policy that would permit it', async () => {
    const at = mark();

    const run = await docker('run', '--rm', '-v', `${workspace}:/ws`, IMAGE, 'true');

    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/not declared in the repository docker policy \(run\.mounts\)/);
    if (logs) {
      const denial = logsSince(at).find((l) => l.policyHint !== undefined);
      expect(denial?.policyHint).toMatch(/path: "\.\/"\n\s*mode: rw/);
    }
  });
  test('creates a declared network, joins a container to it, and removes it', async () => {
    // The unit tests judge a body this file cannot see. Twice a create body
    // they accepted was refused on the wire, because the real CLI sends keys
    // the allowlist was never shown - so the network path is driven by the
    // real CLI here, not only by fixtures.
    const at = mark();

    const created = await docker('network', 'create', '--internal', network);
    expect(created.code, created.stderr).toBe(0);

    // Addressable by the name the job chose, not only by the id the daemon
    // assigned: the proxy records both when it relays the create.
    const inspect = await docker('network', 'inspect', network);
    expect(inspect.code, inspect.stderr).toBe(0);

    const joined = await docker('run', '--rm', '--network', network, IMAGE, 'true');
    expect(joined.code, joined.stderr).toBe(0);

    const removed = await docker('network', 'rm', network);
    expect(removed.code, removed.stderr).toBe(0);

    if (logs) {
      const since = logsSince(at);
      expect(since.some((l) => /forwarded POST \/networks\/create/.test(l.message))).toBe(true);
      expect(since.filter((l) => /^(denied|refused) /.test(l.message))).toEqual([]);
    }
  });

  test('refuses a network the policy does not declare, and one declared internal made routable', async () => {
    const at = mark();

    const undeclared = await docker('network', 'create', 'not-declared-by-policy');
    expect(undeclared.code).not.toBe(0);
    expect(undeclared.stderr).toMatch(/not declared in the repository docker policy \(run\.networks\)/);

    // The name matches, but dropping --internal asks for a routable network,
    // which is strictly more reachable than what the policy granted.
    const routable = await docker('network', 'create', `${network}-routable`);
    expect(routable.code).not.toBe(0);
    expect(routable.stderr).toMatch(/declared internal, so it cannot be created routable/);

    if (logs) {
      expect(logsSince(at).some((l) => /denied POST \/networks\/create/.test(l.message))).toBe(true);
    }
  });
});
