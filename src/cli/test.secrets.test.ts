/**
 * Where `localmost test` takes a workflow's secrets from.
 *
 * A workflow names the secrets it wants, and the checkout is as untrusted as
 * its code. Read from the environment under their own names, any variable
 * the developer happened to export - AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN,
 * NPM_TOKEN - went to a workflow that asked for it by that name.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { resolveSecrets } from './test';

describe('resolveSecrets', () => {
  const saved = { ...process.env };
  let logged: string[];

  beforeEach(() => {
    logged = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '));
    });
  });

  afterEach(() => {
    jest.mocked(console.log).mockRestore();
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  });

  it('does not hand a workflow a variable exported under the name it asks for', async () => {
    process.env.AWS_SECRET_ACCESS_KEY = 'leak';
    const secrets = await resolveSecrets('o/r', ['AWS_SECRET_ACCESS_KEY'], 'stub');
    expect(secrets).toEqual({ AWS_SECRET_ACCESS_KEY: '' });
    // ...but says why, and how to pass it on purpose.
    expect(logged.join('\n')).toContain('LOCALMOST_SECRET_AWS_SECRET_ACCESS_KEY');
  });

  it('takes a secret from LOCALMOST_SECRET_<name>', async () => {
    process.env.LOCALMOST_SECRET_NPM_TOKEN = 'meant-for-the-workflow';
    process.env.NPM_TOKEN = 'the-developer-s-own';
    expect(await resolveSecrets('o/r', ['NPM_TOKEN'], 'abort')).toEqual({ NPM_TOKEN: 'meant-for-the-workflow' });
  });

  it('names the variable to set when a secret is missing', async () => {
    delete process.env.LOCALMOST_SECRET_DEPLOY_KEY;
    await expect(resolveSecrets('o/r', ['DEPLOY_KEY'], 'abort')).rejects.toThrow(/LOCALMOST_SECRET_DEPLOY_KEY/);
  });
});
