import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  maskSecrets,
  createSecretMasker,
  buildStepEnvironment,
  executeStep,
  withoutReservedEnv,
  type ExecutionContext,
  type RunnerStep,
  type RunnerStepResult,
  type StepRunner,
} from './step-executor';

const GUEST = '/Users/runner/work/workspace';
const job = { 'runs-on': 'self-hosted', steps: [] } as never;

/** A runner that runs nothing: it records each step and answers as told. */
class FakeRunner implements StepRunner {
  readonly workDir = GUEST;
  readonly steps: RunnerStep[] = [];
  readonly provided: string[] = [];
  answer: (step: RunnerStep) => RunnerStepResult = () => ({ exitCode: 0, outputs: '' });
  async provide(hostDir: string): Promise<string> {
    this.provided.push(hostDir);
    return '/Users/runner/work/actions/0123456789abcdef';
  }
  async run(step: RunnerStep): Promise<RunnerStepResult> {
    this.steps.push(step);
    return this.answer(step);
  }
  async endJob(): Promise<void> {}
}

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
  const ctx = {
    workDir: GUEST,
    workflowEnv: {},
    jobEnv: {},
    matrix: {},
    secrets: { MY_TOKEN: 'ghp_supersecretvalue' },
  };

  it('does not put secrets in the step environment', () => {
    // GitHub exposes secrets through ${{ secrets.X }}, not the environment.
    // Exporting them would hand every secret to every child process.
    const env = buildStepEnvironment({ run: 'echo hi' } as never, ctx as never, job);

    expect(env.MY_TOKEN).toBeUndefined();
    expect(Object.values(env)).not.toContain('ghp_supersecretvalue');
  });

  it("leaves HOME, PATH, the user and temp to the guest, and gives none of this machine's", () => {
    const env = buildStepEnvironment({ run: 'echo hi' } as never, ctx as never, job);

    for (const name of ['HOME', 'PATH', 'USER', 'SHELL', 'TMPDIR', 'GIT_SSH_COMMAND']) {
      expect([name, env[name]]).toEqual([name, undefined]);
    }
    expect(Object.values(env)).not.toContain(os.homedir());
  });

  it('points the workspace, the runner temp and the tool cache into the workspace as steps see it', () => {
    const env = buildStepEnvironment({ run: 'echo hi' } as never, ctx as never, job);

    expect(env.GITHUB_WORKSPACE).toBe(GUEST);
    expect(env.RUNNER_TEMP).toBe(`${GUEST}/.runner-temp`);
    expect(env.RUNNER_TOOL_CACHE).toBe(`${GUEST}/.runner-tool-cache`);
    expect(env.GITHUB_ENV).toBe(`${GUEST}/.github-env`);
  });

  it("never lets a job's or a step's env replace a GITHUB_* or RUNNER_* default", () => {
    // GitHub does not let them, and both are the checkout's to write: a job
    // naming GITHUB_REPOSITORY would give its steps, and github.repository,
    // another repository's identity.
    const runCtx = {
      ...ctx,
      workflowEnv: { GITHUB_REPOSITORY: 'me/repo', GITHUB_SHA: 'abc123' },
      jobEnv: { GITHUB_JOB: 'build', GITHUB_REPOSITORY: 'victim/repo', RUNNER_TEMP: '/tmp', JOB_ONLY: 'j' },
    };
    const step = {
      run: 'echo hi',
      env: {
        GITHUB_SHA: 'deadbeef',
        GITHUB_WORKSPACE: '/Users/victim',
        RUNNER_OS: 'Linux',
        GITHUB_TOKEN: 'from-the-step',
        SEEN_REPOSITORY: '${{ github.repository }}',
      },
    };
    const env = buildStepEnvironment(step as never, runCtx as never, job);

    expect(env).toMatchObject({
      GITHUB_REPOSITORY: 'me/repo',
      GITHUB_SHA: 'abc123',
      GITHUB_JOB: 'build',
      GITHUB_WORKSPACE: GUEST,
      RUNNER_TEMP: `${GUEST}/.runner-temp`,
      RUNNER_OS: 'macOS',
      SEEN_REPOSITORY: 'me/repo',
      // Names the run does not set stay the workflow's.
      GITHUB_TOKEN: 'from-the-step',
      JOB_ONLY: 'j',
    });
  });
});

describe('withoutReservedEnv', () => {
  it("drops the run's GITHUB_* and RUNNER_* names, and keeps the rest", () => {
    expect(
      withoutReservedEnv({ GITHUB_REPOSITORY: 'victim/repo', GITHUB_RUN_ID: '1', RUNNER_NAME: 'x', GITHUB_TOKEN: 't', NODE_ENV: 'test' })
    ).toEqual({ GITHUB_TOKEN: 't', NODE_ENV: 'test' });
    expect(withoutReservedEnv(undefined)).toEqual({});
  });
});

describe('executeStep', () => {
  let host: string;
  let runner: FakeRunner;
  let output: string[];

  const context = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
    workDir: GUEST,
    hostWorkDir: host,
    runner,
    workflowEnv: {},
    jobEnv: {},
    matrix: {},
    secrets: { TOKEN: 'ghp_supersecretvalue' },
    stepOutputs: {},
    onOutput: (line, stream) => output.push(`${stream}: ${line}`),
    ...overrides,
  });

  beforeEach(() => {
    host = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'step-exec-')));
    runner = new FakeRunner();
    output = [];
  });

  afterEach(() => {
    fs.rmSync(host, { recursive: true, force: true });
  });

  it("runs a run: step's script in its shell, from the workspace, and reads its outputs", async () => {
    runner.answer = () => ({ exitCode: 0, outputs: 'a=1\nnotes<<EOF\nline one\nline two\nEOF\n' });
    const ctx = context();
    const result = await executeStep(
      { id: 'build', run: 'echo "${{ secrets.TOKEN }}" | ./deploy', shell: 'zsh' } as never,
      ctx,
      job
    );

    expect(result).toMatchObject({ status: 'success', exitCode: 0, outputs: { a: '1', notes: 'line one\nline two' } });
    expect(ctx.stepOutputs.build).toEqual({ a: '1', notes: 'line one\nline two' });
    expect(runner.steps[0]).toMatchObject({ program: 'zsh', script: 'echo "ghp_supersecretvalue" | ./deploy', cwd: GUEST });
    expect(runner.steps[0].env.TOKEN).toBeUndefined();
  });

  it("masks secrets in a step's output and in its error, even one split across lines", async () => {
    runner.answer = (step) => {
      step.onLine('token: ghp_supersecretvalue', 'stdout');
      step.onLine('-----BEGIN', 'stderr');
      step.onLine('KEY----- failed', 'stderr');
      return { exitCode: 2, outputs: '' };
    };
    const result = await executeStep(
      { run: 'x' } as never,
      context({ secrets: { TOKEN: 'ghp_supersecretvalue', KEY: '-----BEGIN\nKEY-----' } }),
      job
    );

    expect(result).toMatchObject({ status: 'failure', exitCode: 2 });
    expect(output).toEqual(['stdout: token: ***', 'stderr: *** failed']);
    expect(result.error).toBe('*** failed');
  });

  it('starts a step in its working-directory, never outside the workspace', async () => {
    await executeStep({ run: 'x', 'working-directory': 'packages/app' } as never, context(), job);
    expect(runner.steps[0].cwd).toBe(`${GUEST}/packages/app`);

    for (const dir of ['../..', '/etc']) {
      const result = await executeStep({ run: 'x', 'working-directory': dir } as never, context(), job);
      expect(result).toMatchObject({ status: 'failure', error: expect.stringMatching(/outside the workspace/) });
    }
    expect(runner.steps).toHaveLength(1);
  });

  it('refuses a shell the macOS VM does not run', async () => {
    const result = await executeStep({ run: 'print(1)', shell: 'python' } as never, context(), job);
    expect(result).toMatchObject({ status: 'failure', error: expect.stringMatching(/shell: python is not available/) });
    expect(runner.steps).toHaveLength(0);
  });

  it("runs a local node action from the workspace, its entry point where steps see the action", async () => {
    const action = path.join(host, '.github', 'actions', 'greet');
    fs.mkdirSync(path.join(action, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(action, 'dist', 'index.js'), '');
    fs.writeFileSync(
      path.join(action, 'action.yml'),
      'name: greet\ninputs:\n  who:\n    default: world\n  loud:\n    default: "no"\nruns:\n  using: node20\n  main: dist/index.js\n'
    );
    await executeStep({ uses: './.github/actions/greet', with: { loud: 'yes' } } as never, context(), job);

    expect(runner.steps[0]).toMatchObject({ program: 'node', entry: `${GUEST}/.github/actions/greet/dist/index.js`, cwd: GUEST });
    expect(runner.steps[0].env).toMatchObject({ INPUT_WHO: 'world', INPUT_LOUD: 'yes' });
    expect(runner.provided).toEqual([]);
  });

  it("refuses a local action, or an entry point, outside where it belongs", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'step-exec-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'action.yml'), 'name: x\nruns:\n  using: node20\n  main: index.js\n');
      const away = await executeStep({ uses: `./${path.relative(host, outside)}` } as never, context(), job);
      expect(away).toMatchObject({ status: 'failure', error: expect.stringMatching(/outside the workspace/) });

      const action = path.join(host, 'act');
      fs.mkdirSync(action);
      fs.writeFileSync(path.join(action, 'action.yml'), 'name: x\nruns:\n  using: node20\n  main: ../../etc/passwd\n');
      const escape = await executeStep({ uses: './act' } as never, context(), job);
      expect(escape).toMatchObject({ status: 'failure', error: expect.stringMatching(/outside the action|does not exist/) });
      expect(runner.steps).toHaveLength(0);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("runs a composite action's steps one by one", async () => {
    const action = path.join(host, 'comp');
    fs.mkdirSync(action);
    fs.writeFileSync(
      path.join(action, 'action.yml'),
      'name: comp\nruns:\n  using: composite\n  steps:\n    - run: echo one\n      shell: bash\n    - run: echo two\n      shell: sh\n'
    );
    const result = await executeStep({ uses: './comp' } as never, context(), job);
    expect(result.status).toBe('success');
    expect(runner.steps.map((s) => [s.program, s.script])).toEqual([['bash', 'echo one'], ['sh', 'echo two']]);
  });

  it('treats a cache as a miss, and saves nothing, until the macOS VM keeps caches', async () => {
    const restore = await executeStep({ uses: 'actions/cache@v4', with: { key: 'k', path: 'node_modules' } } as never, context(), job);
    expect(restore).toMatchObject({ status: 'success', outputs: { 'cache-hit': 'false' } });
    const save = await executeStep({ uses: 'actions/cache/save@v4', with: { key: 'k', path: 'node_modules' } } as never, context(), job);
    expect(save.status).toBe('success');
    expect(output.join('\n')).toMatch(/keeps no caches in the macOS VM yet/);
    expect(runner.steps).toHaveLength(0);
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
