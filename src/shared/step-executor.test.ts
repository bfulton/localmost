import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { maskSecrets, createSecretMasker, buildStepEnvironment } from './step-executor';

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
