import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  maskSecrets,
  createSecretMasker,
  buildStepEnvironment,
  trackStepProcessGroup,
  reapStepProcesses,
} from './step-executor';

describe('reapStepProcesses', () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('kills what a step left running after the step itself exited', async () => {
    // A step that backgrounds a process and exits: the survivor keeps running
    // after the step, and after the job, unless something reaps its group.
    const step = spawn('/bin/sh', ['-c', '/bin/sleep 60 >/dev/null 2>&1 & echo $!'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    trackStepProcessGroup(step);
    let out = '';
    step.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    // 'close', not 'exit': the pid it printed may not have been read yet at exit.
    await new Promise((resolve) => step.on('close', resolve));
    const survivor = parseInt(out.trim(), 10);
    try {
      expect(alive(survivor)).toBe(true);

      reapStepProcesses();

      for (let i = 0; i < 250 && alive(survivor); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(alive(survivor)).toBe(false);
    } finally {
      if (alive(survivor)) process.kill(survivor, 'SIGKILL');
    }
  });

  it('leaves alone a group whose leader pid now belongs to someone else', () => {
    // Once the step and its survivors are gone the pid can be reused, and a
    // process group led by the new owner is not ours to kill.
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const fake = { pid: 424242, once: (_e: string, cb: () => void) => cb() };
      trackStepProcessGroup(fake as never);
      reapStepProcesses();
      expect(kill).toHaveBeenCalledWith(424242, 0);
      expect(kill).not.toHaveBeenCalledWith(-424242, 'SIGKILL');
    } finally {
      kill.mockRestore();
    }
  });
});

describe('maskSecrets', () => {
  const secrets = { TOKEN: 'ghp_supersecretvalue', SHORT: 'ab' };

  it('replaces a secret wherever it appears in output', () => {
    // A step can print a secret by accident, and that output is streamed to the
    // console and written to the log file.
    const line = 'curl failed for https://x/?t=ghp_supersecretvalue (ghp_supersecretvalue)';

    expect(maskSecrets(line, secrets)).toBe('curl failed for https://x/?t=*** (***)');
  });

  it('leaves output alone when no secret appears', () => {
    expect(maskSecrets('nothing to see', secrets)).toBe('nothing to see');
  });

  it('ignores values too short to match meaningfully', () => {
    // Masking a two-character value would redact half of ordinary output.
    expect(maskSecrets('grab a cab', secrets)).toBe('grab a cab');
  });

  it('handles an empty secret set', () => {
    expect(maskSecrets('anything', {})).toBe('anything');
  });
});

describe('buildStepEnvironment', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-env-'));

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const ctx = {
    workDir,
    proxyPort: 1234,
    workflowEnv: {},
    jobEnv: {},
    matrix: {},
    secrets: { MY_TOKEN: 'ghp_supersecretvalue' },
  };

  it('does not put secrets in the step environment', () => {
    // GitHub exposes secrets through ${{ secrets.X }}, not the environment.
    // Exporting them would hand every secret to every child process.
    const env = buildStepEnvironment(
      { run: 'echo hi' } as never,
      ctx as never,
      { 'runs-on': 'self-hosted', steps: [] } as never
    );

    expect(env.MY_TOKEN).toBeUndefined();
    expect(Object.values(env)).not.toContain('ghp_supersecretvalue');
  });

  it('points HOME inside the workspace', () => {
    const env = buildStepEnvironment(
      { run: 'echo hi' } as never,
      ctx as never,
      { 'runs-on': 'self-hosted', steps: [] } as never
    );

    expect(env.HOME).toBe(path.join(workDir, '.home'));
    // Every step gets this HOME, so it has to exist by the time one runs.
    expect(fs.existsSync(env.HOME)).toBe(true);
  });

  it('keeps the tool cache inside the workspace', () => {
    // A tool cache shared across runs is one a checkout can poison for the
    // next, and the app's data directory is not writable from a step at all.
    const env = buildStepEnvironment(
      { run: 'echo hi' } as never,
      ctx as never,
      { 'runs-on': 'self-hosted', steps: [] } as never
    );

    expect(path.dirname(env.RUNNER_TOOL_CACHE)).toBe(workDir);
  });

  it('points temp, and the caches tools keep in the shared temp directories, into the workspace', () => {
    // The sandbox grants no shared temp directory. Each of these moves a tool
    // that would otherwise need one: xcrun cannot find a tool at all without a
    // cache it can write, clang and swiftc keep their module cache in the
    // per-user cache directory, and zsh puts here-documents under /tmp.
    const env = buildStepEnvironment(
      { run: 'echo hi' } as never,
      ctx as never,
      { 'runs-on': 'self-hosted', steps: [] } as never
    );

    const tmp = path.join(workDir, '.tmp');
    expect(env).toMatchObject({ TMPDIR: tmp, TMP: tmp, TEMP: tmp });
    expect(path.dirname(env.xcrun_db)).toBe(tmp);
    expect(path.dirname(env.CLANG_MODULE_CACHE_PATH)).toBe(tmp);
    expect(path.dirname(env.TMPPREFIX)).toBe(tmp);
    expect(fs.statSync(tmp).isDirectory()).toBe(true);
  });
});

describe('createSecretMasker', () => {
  const secrets = { TOKEN: 'ghp_supersecretvalue' };

  it('masks a secret split across two chunks', () => {
    // Node decides chunk boundaries, so a secret can arrive in pieces that
    // are each individually harmless-looking.
    const masker = createSecretMasker(secrets);
    const out = masker.push('token=ghp_super') + masker.push('secretvalue rest\n') + masker.flush();

    expect(out).not.toContain('ghp_supersecretvalue');
    expect(out).toBe('token=*** rest\n');
  });

  it('masks a secret split one character at a time', () => {
    const masker = createSecretMasker(secrets);
    const out = 'ghp_supersecretvalue'.split('').map((c) => masker.push(c)).join('') + masker.flush();

    expect(out).toBe('***');
  });

  it('masks a multi-line secret spanning chunks', () => {
    const key = '-----BEGIN KEY-----\nabcdefgh\n-----END KEY-----';
    const masker = createSecretMasker({ KEY: key });
    const out = masker.push('k: -----BEGIN KEY-----\nabc') + masker.push('defgh\n-----END KEY-----!') + masker.flush();

    expect(out).not.toContain('abcdefgh');
    expect(out).toBe('k: ***!');
  });

  it('does not withhold output that cannot start a secret', () => {
    const masker = createSecretMasker(secrets);

    expect(masker.push('ordinary log line\n')).toBe('ordinary log line\n');
  });

  it('passes text through unchanged when there are no secrets', () => {
    const masker = createSecretMasker({});

    expect(masker.push('a') + masker.push('b') + masker.flush()).toBe('ab');
  });
});
