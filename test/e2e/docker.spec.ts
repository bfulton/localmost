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
 * It reaches a real filter one of three ways, so it runs on every leg and
 * never skips:
 *
 *   Inside a localmost job: the runner already serves the job a filtering
 *   socket bound to this repository's approved .localmostrc, and DOCKER_HOST
 *   names it. Driving that socket exercises the production proxy rather than
 *   one this file built. The CLI's exit codes and output carry the proof
 *   there, since the production proxy's log is not this process's to read.
 *
 *   On the Mac, outside a job: this file serves the socket itself, the way
 *   RunnerManager does - in a worker's sandbox, bound on claim to the policy
 *   - over the app's own backend: VmBackend and VmManager, with the helper,
 *   guest and docker CLI that `npm run build:native` leaves in build/. A
 *   real VM boots at the claim, and the job's pulls are made on the Mac. It
 *   asserts on the proxy's and the worker's log as well as on the CLI, and
 *   on the VM: none for a job whose policy has no docker section, one booted
 *   at the claim for this one, and its directory gone when the job ends.
 *
 *   Off macOS (the ubuntu-latest CI leg), where no VM runs: the same, over a
 *   test-only worker that forwards to the runner's native dockerd and pulls
 *   through it (owner decision 3). It lives in test/e2e/support and the app
 *   can never choose it.
 *
 * A missing daemon, build or served socket is a failure naming what to
 * provision. Never a skip, never a fake: the point is the real thing.
 */

import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DockerBackend, WorkerDocker } from '../../src/main/docker/docker-backend';
import { DockerFilterProxy, DockerFilterProxyLogEntry } from '../../src/main/docker/docker-filter-proxy';
import { shortTempDir } from '../../src/main/test-utils/vm-fixtures';
import type { VmHandle } from '../../src/main/vm/types';
import { DockerPolicy } from '../../src/shared/docker-policy';
import { NATIVE_DAEMON_SOCKET, NativeDockerBackend } from './support/native-worker-docker';
import type { VmHarness } from './support/vm-worker-docker';

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

// Inside a localmost job, DOCKER_HOST names a socket the runner serves the job,
// never the daemon itself; GITHUB_ACTIONS marks a job, as opposed to a
// developer shell that happens to export DOCKER_HOST, and localmost runs jobs
// on macOS only.
const dockerHost = process.env.DOCKER_HOST;
const hostSocket = dockerHost?.startsWith('unix://') ? dockerHost.slice('unix://'.length) : undefined;
const insideJob = process.env.GITHUB_ACTIONS === 'true' && process.platform === 'darwin' && hostSocket !== undefined;

type Mode = 'job' | 'vm' | 'native';
const mode: Mode = insideJob ? 'job' : process.platform === 'darwin' ? 'vm' : 'native';

/** What `npm run build:native` leaves in build/, which the Mac mode runs on, as a packaged app runs on Resources. */
const vmResources = path.resolve(__dirname, '..', '..', 'build');
const vmBuild = {
  helper: path.join(vmResources, 'localmost-vm'),
  guest: path.join(vmResources, 'guest', 'manifest.json'),
  cli: path.join(vmResources, 'docker-cli', 'docker'),
};

/** Off macOS, the runner's own daemon: where DOCKER_HOST points, if anywhere, else the usual socket. */
const nativeSocket = hostSocket ?? NATIVE_DAEMON_SOCKET;

/** The job's docker: the bundled CLI on the Mac, as the app puts it first on a job's PATH, else the one on PATH. */
const dockerCli = mode === 'vm' ? vmBuild.cli : findDockerCli();

/** What is missing to run this for real, if anything. Reported as a failure, never a skip. */
const missingReason = ((): string | null => {
  if (mode === 'vm') {
    const missing = Object.values(vmBuild).filter((file) => !fs.existsSync(file));
    return missing.length === 0
      ? null
      : `the VM backend's build is missing: ${missing.map((file) => path.relative(process.cwd(), file)).join(', ')}. ` +
          'Run npm run build:native first; on the Mac this suite boots a real Docker VM from build/.';
  }
  if (!dockerCli) return 'no docker CLI on PATH to drive the socket with. Install Docker where these tests run.';
  if (mode === 'job') {
    return fs.existsSync(hostSocket!)
      ? null
      : `DOCKER_HOST names ${hostSocket}, but nothing is served there. The runner serves a job its docker socket only once the repository's docker policy is approved.`;
  }
  return fs.existsSync(nativeSocket)
    ? null
    : `no Docker daemon at ${nativeSocket}. Install and start Docker where these tests run.`;
})();

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

test.describe('a job using docker through the filtering socket', () => {
  // A real VM boots at the claim, and the first pull fetches from a registry.
  test.describe.configure({ timeout: mode === 'vm' ? 180_000 : 60_000 });

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

  /** The Mac mode's VMs; and how many the backend had asked for just before and just after the claim. */
  let vms: VmHarness | undefined;
  let startedBeforeClaim = -1;
  let startedAtClaim = -1;

  // A real directory outside any workspace, so the refusal is "outside the job
  // workspace" rather than "cannot be resolved". Stands in for ~/.ssh.
  const outside = '/etc';

  test.beforeAll(async () => {
    // Fail here with the real reason, so the tests below do not each fail on
    // a confusing consequence (a proxy with no endpoint, a spawn of no CLI).
    if (missingReason) throw new Error(missingReason);

    let socketPath: string;
    let dockerConfig: string;
    if (mode === 'job') {
      // Short prefix: a socket path is capped at 104 bytes and tmpdir is long.
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-e2e-'));
      socketPath = hostSocket!;
      // Inside the job's own checkout, which the production proxy roots mounts
      // at; a declared "./" permits any path below it, at or below its mode.
      jobWorkspace = fs.mkdtempSync(path.join(process.cwd(), '.docker-e2e-'));
      workspace = fs.realpathSync.native(jobWorkspace);
      dockerConfig = path.join(scratch, 'docker-config');
      fs.mkdirSync(dockerConfig);
    } else {
      const captured: DockerFilterProxyLogEntry[] = [];
      logs = captured;
      let backend: DockerBackend;
      let worker: WorkerDocker;
      let sandboxDir: string;
      if (mode === 'vm') {
        // <data> as short as the temp directory allows: a VM's sockets are
        // 35 or 36 bytes below it, and a socket path fits in 103.
        scratch = shortTempDir();
        // Loaded only here: it builds on the VM backend's modules, the puller
        // among them, and stands in Electron's API for them, none of which
        // the other modes use.
        const { VmHarness } = require('./support/vm-worker-docker') as typeof import('./support/vm-worker-docker');
        vms = await VmHarness.create(scratch, vmResources, (level, message) =>
          captured.push({ level: level === 'error' ? 'warn' : level, message: `[vm manager] ${message}` })
        );
        const sandbox = vms.newSandbox(1);
        sandboxDir = sandbox.sandboxDir;
        backend = vms.backend;
        worker = vms.forWorker(1, sandbox, (entry) => captured.push(entry));
        dockerConfig = path.join(sandboxDir, '.docker');
      } else {
        // Short prefix: a socket path is capped at 104 bytes and tmpdir is long.
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-e2e-'));
        sandboxDir = scratch;
        backend = new NativeDockerBackend(nativeSocket);
        worker = backend.forWorker({
          slot: 1,
          sandboxDir,
          sandboxId: '1-000000000000',
          shareNonce: '',
          proxy: () => ({ port: 0, url: '' }),
          log: (entry) => captured.push(entry),
        });
        dockerConfig = path.join(scratch, 'docker-config');
        fs.mkdirSync(dockerConfig);
      }
      // The checkout the backend roots mounts at, for the repository this
      // socket is bound to below: the runner lays it out as
      // _work/<repo>/<repo>, and declared paths resolve against it. Resolved
      // as the daemon sees it, since tmpdir is under /var, a symlink.
      const workDir = backend.workspaceMountRoot(sandboxDir, REPOSITORY);
      fs.mkdirSync(workDir, { recursive: true });
      workspace = fs.realpathSync.native(workDir);

      socketPath = path.join(sandboxDir, 'docker.sock');
      proxy = new DockerFilterProxy({ backend, worker, onLog: (entry) => captured.push(entry) });
      await proxy.start(socketPath);
      startedBeforeClaim = vms?.started.length ?? -1;
      proxy.bind(REPOSITORY, policy);
      startedAtClaim = vms?.started.length ?? -1;
    }
    fs.writeFileSync(path.join(workspace, 'hello.txt'), `${nonce}\n`);

    // The job's environment: the served socket, and a docker config of its
    // own so the operator's contexts and credential helpers play no part.
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
    if (env && mode !== 'vm') await docker('network', 'rm', network).catch(() => undefined);
    await proxy?.stop();
    await vms?.shutdown();
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    if (jobWorkspace) fs.rmSync(jobWorkspace, { recursive: true, force: true });
  });

  /** Run the docker CLI as the job, reporting the exit code rather than throwing on it. */
  const dockerWith = (jobEnv: NodeJS.ProcessEnv, ...args: string[]): Promise<Run> =>
    new Promise((resolve, reject) => {
      const child = spawn(dockerCli!, args, { env: jobEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  const docker = (...args: string[]): Promise<Run> => dockerWith(env, ...args);

  /** The socket's log entries since a point in the test, when this file serves it. */
  const mark = (): number => logs?.length ?? 0;
  const logsSince = (at: number): DockerFilterProxyLogEntry[] => (logs ?? []).slice(at);

  /** The VM booted for this job at the claim. */
  const claimedVm = (): VmHandle => vms!.started[0];

  if (mode === 'vm') {
    test('boots no VM for a job whose policy has no docker section, and answers it from the guest', async () => {
      // A second worker, claimed for a job whose policy grants nothing: its
      // socket is served and bound, as every worker's is, and nothing boots.
      const sandbox = vms!.newSandbox(2);
      const socketPath = path.join(sandbox.sandboxDir, 'docker.sock');
      const entries: DockerFilterProxyLogEntry[] = [];
      const worker = vms!.forWorker(2, sandbox, (entry) => entries.push(entry));
      const other = new DockerFilterProxy({ backend: vms!.backend, worker, onLog: (entry) => entries.push(entry) });
      await other.start(socketPath);
      try {
        const before = vms!.started.length;
        other.bind(REPOSITORY, {});
        const otherEnv = { ...env, DOCKER_HOST: `unix://${socketPath}`, DOCKER_CONFIG: path.join(sandbox.sandboxDir, '.docker') };

        // The CLI still starts: the baseline comes from the guest's manifest.
        const version = await dockerWith(otherEnv, 'version', '--format', '{{.Server.Os}}/{{.Server.Arch}}');
        expect(version.code, version.stderr).toBe(0);
        expect(version.stdout.trim()).toBe('linux/arm64');
        const run = await dockerWith(otherEnv, 'run', '--rm', IMAGE, 'true');
        expect(run.code).not.toBe(0);

        expect(vms!.started.length).toBe(before);
        expect(entries.filter((l) => /Docker VM .* booting/.test(l.message))).toEqual([]);
      } finally {
        await other.stop();
      }
    });

    test("boots the job's own VM at the claim, and none before it", async () => {
      expect([startedBeforeClaim, startedAtClaim]).toEqual([0, 1]);
      const vm = claimedVm();
      expect(vm.vmId).toMatch(/^1-[0-9a-f]{12}$/);
      expect(logs!.some((l) => l.message === `Docker VM ${vm.vmId} booting for ${REPOSITORY} at the claim`)).toBe(true);
      const ready = await vm.ready();
      expect(ready.docker.apiVersion).toMatch(/^1\.\d+$/);
      expect(fs.existsSync(vms!.vmDir(vm))).toBe(true);
    });
  } else {
    test('checks the Docker VM on the Mac, outside a job, where one can boot', () => {
      // Inside a job the VM is the installed app's, which this process cannot
      // see; off macOS there is none (owner decision 3). The Mac mode above
      // is where the VM's own checks run.
      expect(mode === 'job' ? insideJob : process.platform !== 'darwin').toBe(true);
    });
  }

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
      // A pull is never forwarded: the worker pulls it (the VM's on the Mac,
      // the native one through its daemon).
      expect(since.some((l) => /pulled POST \/images\/create through the worker/.test(l.message))).toBe(true);
      expect(since.some((l) => /forwarded POST \/images\/create/.test(l.message))).toBe(false);
      expect(since.some((l) => /forwarded POST \/containers\/create/.test(l.message))).toBe(true);
      expect(since.filter((l) => /^(denied|refused) /.test(l.message))).toEqual([]);
    }
    if (mode === 'vm') {
      // Made on the Mac, where the credentials are, and loaded into this job's VM.
      const pulled = new RegExp(
        String.raw`^pulled docker\.io/library/alpine:3 \(sha256:[0-9a-f]{64}, linux/arm64[^)]*\) on the Mac; (loaded into|already in) VM ` +
          claimedVm().vmId +
          '$'
      );
      expect(logsSince(at).filter((l) => pulled.test(l.message))).toHaveLength(1);
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

  test('joins one container to two of its own networks, the dual-homed bridge', async () => {
    // The arrangement a job needs to seal a run: the agent sits alone on an
    // internal network with no route anywhere, and a broker container joins
    // both that network and a routable one, so it is the only way out. On
    // macOS the internal network's gateway lives inside the job's VM and
    // cannot be bound from the host at all, so a host-side broker is not an
    // option - this is the portable shape.
    //
    // Both names have to pass: one arrives as HostConfig.NetworkMode, the
    // other as NetworkingConfig.EndpointsConfig, and until they were held to
    // the same rule the second was not checked at all.
    const at = mark();
    const sealed = `${network}-sealed`;
    const second = `${network}-second`;

    for (const name of [sealed, second]) {
      const created = await docker('network', 'create', '--internal', name);
      expect(created.code, created.stderr).toBe(0);
    }

    // Both user-defined: docker refuses to mix the default bridge with a
    // user-defined network ("cannot attach both user-defined and
    // non-user-defined network-modes"), so a real dual-homed broker declares
    // its routable side as a network too. Both are internal here because that
    // is what this repository's policy declares; what the filter has to get
    // right is that two owned names pass, one through HostConfig.NetworkMode
    // and one through NetworkingConfig.EndpointsConfig.
    const dual = await docker(
      'run', '--rm', '--network', sealed, '--network', second, IMAGE,
      'sh', '-c', 'ip -o -4 addr show | grep -c eth'
    );
    expect(dual.code, dual.stderr).toBe(0);
    // Two container interfaces: one per network.
    expect(dual.stdout.trim()).toBe('2');

    expect((await docker('network', 'rm', sealed, second)).code).toBe(0);
    if (logs) expect(logsSince(at).filter((l) => /^(denied|refused) /.test(l.message))).toEqual([]);
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

  if (mode === 'vm') {
    // Last: the job ends, as a worker's exit ends it, and its VM goes with it.
    test("releases the job's VM when the job ends, and its directory goes with it", async () => {
      const vm = claimedVm();
      const at = mark();

      await proxy!.stop();

      expect(vm.state()).toBe('stopped');
      expect(fs.existsSync(vms!.vmDir(vm))).toBe(false);
      expect(logsSince(at).some((l) => l.message === `Docker VM ${vm.vmId} released: the job ended`)).toBe(true);
      // Not a failure: the stop was the job's end, asked for.
      expect(vm.failure()).toBeUndefined();
    });
  }
});
