/**
 * Tests for the backend seam: where declared mounts are rooted, what a
 * runner given no backend serves, and that the Docker Desktop backend, which
 * the per-job VM replaced, stays gone.
 */

import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { NO_DAEMON_MESSAGE, noDockerBackend, runnerWorkspaceRoot, WorkerContext } from './docker-backend';

describe('the root that declared mount paths resolve against', () => {
  it('is the repository checkout, which is what "./" means in a workflow', () => {
    // The runner checks out into _work/<repo>/<repo> (GITHUB_WORKSPACE). Rooting
    // at _work instead made every declared path narrower than "./" unmatchable:
    // "./tmp/fixtures" resolved to _work/tmp/fixtures, which never exists.
    expect(runnerWorkspaceRoot('/s/1', 'bfulton/localmost')).toBe('/s/1/_work/localmost/localmost');
  });

  it('falls back to the work folder when no repository is bound yet', () => {
    expect(runnerWorkspaceRoot('/s/1')).toBe('/s/1/_work');
  });
});

describe('the backend of a runner given none', () => {
  // Every app builds the VM backend. A RunnerManager made without one - a
  // test, or a caller that forgot - gets no Docker at all, never a fallback
  // daemon: owner decision 3.
  const worker = noDockerBackend.forWorker({} as WorkerContext);

  it('never permits privileged, and has nothing to remove at a stop', () => {
    expect(noDockerBackend.supportsPrivileged).toBe(false);
    expect(noDockerBackend.disposable).toBe(true);
    expect(noDockerBackend.workspaceMountRoot('/s/1', 'o/r')).toBe('/s/1/_work/r/r');
  });

  it('answers every request with no daemon, whatever is bound', async () => {
    worker.bind('o/r', { run: { images: ['alpine:3'] } });
    worker.prewarm();
    worker.dropSpare('test');
    expect(worker.running()).toBe(false);
    expect(await worker.endpoint(1000)).toEqual({ kind: 'none', reason: NO_DAEMON_MESSAGE });
    expect(worker.baseline('/_ping')).toEqual({
      status: 503,
      headers: { 'Content-Type': 'application/json' },
      body: { message: NO_DAEMON_MESSAGE },
    });
    expect(worker.containerProxyEnv()).toEqual({});
  });

  it('pulls nothing and approves no binds', async () => {
    await expect(
      worker.pull({ registry: 'docker.io', repositoryPath: 'library/alpine', tag: '3' }, () => {}, new AbortController().signal)
    ).rejects.toThrow(NO_DAEMON_MESSAGE);
    await expect(worker.approveBinds('f'.repeat(64), [])).rejects.toThrow(NO_DAEMON_MESSAGE);
    await expect(worker.release()).resolves.toBeUndefined();
  });
});

describe('the Docker Desktop backend stays removed', () => {
  const root = path.resolve(__dirname, '..', '..', '..');

  /** Every file under a directory of the checkout, as paths relative to the checkout. */
  const filesUnder = (dir: string): string[] =>
    fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) return filesUnder(rel);
      return entry.isFile() ? [rel] : [];
    });
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');
  const isTest = (rel: string): boolean => /\.test\.tsx?$/.test(rel);

  // Spelled in pieces, so that this file is not itself a match.
  const removedNames = ['Desktop' + 'Backend', 'resolveDocker' + 'Endpoint', 'docker-' + 'desktop'];

  it('is named nowhere in src or test', () => {
    const found = [...filesUnder('src'), ...filesUnder('test')].flatMap((rel) =>
      removedNames.filter((name) => read(rel).includes(name)).map((name) => `${rel}: ${name}`)
    );
    expect(found).toEqual([]);
  });

  it("leaves no app code that finds the host's own daemon socket", () => {
    // The socket Docker Desktop serves, and the link to it: nothing in the
    // app names either as a string, so nothing can connect to one. Tests
    // still use them, as bind sources and policy entries a job is refused.
    const daemonPaths = [
      /["'`][^"'`\n]*\/var\/run\/docker\.sock/,
      /["'`][^"'`\n]*\.docker\/run\b/,
      /["'`]\.docker["'`]\s*,\s*["'`]run["'`]/,
    ];
    const found = filesUnder('src')
      .filter((rel) => !isTest(rel))
      .filter((rel) => daemonPaths.some((re) => re.test(read(rel))));
    expect(found).toEqual([]);
  });

  it('spells docker.sock only where the app names the sockets it serves, and never beside /var/run', () => {
    // Whole strings are not the only spelling: path.join('/var', 'run',
    // 'docker.sock') finds the daemon as surely. So the name itself is
    // allowed only in the files that build a socket the app serves, or say
    // what one is, and in no file that also spells /var/run.
    const allowed = [
      // DOCKER_SOCKET_NAME: the filtering socket, in the worker's sandbox.
      'src/main/runner-manager.ts',
      // A job VM's socket, and the refresh VM's, under <data>/vm.
      'src/main/vm/paths.ts',
      // A comment in the helper's profile, on the sockets it binds there.
      'src/main/vm/helper-profile.ts',
      // Discovery's hint when a job reached a socket of that name.
      'src/cli/test.ts',
      // The longest VM socket path, for the tests that must fit it.
      'src/main/test-utils/vm-fixtures.ts',
    ].map((rel) => path.join(...rel.split('/')));
    // Code only: a comment line's apostrophe ("the VM's docker.sock") is not
    // a string, and a comment connects to nothing.
    const code = (rel: string): string =>
      read(rel)
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .join('\n');
    const socketName = /["'`][^"'`\n]*docker\.sock/;
    const varRun = [/["'`][^"'`\n]*\/var\/run/, /["'`]\/var["'`]\s*,\s*["'`]run["'`]/];
    const spelling = filesUnder('src')
      .filter((rel) => !isTest(rel) && socketName.test(code(rel)))
      .filter((rel) => !allowed.includes(rel) || varRun.some((re) => re.test(code(rel))));
    expect(spelling).toEqual([]);
    // Each allowed file still spells it, so the list cannot outlive its reason.
    expect(allowed.filter((rel) => !socketName.test(code(rel)))).toEqual([]);
  });

  it("imports the e2e spec's native forwarder from no app code", () => {
    // The Linux leg of test/e2e/docker.spec.ts forwards to a runner's native
    // dockerd through it (owner decision 3). It is a second backend, so it
    // must never be one the app can choose.
    // Spelled in pieces too, and checked to exist, so that a rename cannot
    // leave this test passing on a name nothing has.
    const forwarder = 'native-worker' + '-docker';
    expect(fs.existsSync(path.join(root, 'test', 'e2e', 'support', `${forwarder}.ts`))).toBe(true);
    expect(filesUnder('src').filter((rel) => read(rel).includes(forwarder))).toEqual([]);
  });
});
