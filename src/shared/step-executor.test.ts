import { maskSecrets, buildStepEnvironment } from './step-executor';

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
    workDir: '/work',
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

    expect(env.HOME).toBe('/work/.home');
  });
});
