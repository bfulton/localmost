import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CREDENTIAL_HELPER_DIRS,
  RegistryAuthError,
  resolveRegistryCredentials,
} from './registry-auth';

// Held so a test can show the helper never runs synchronously: a blocking
// helper would stall Electron main, and with it every job's filter.
jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  return { ...actual, execFileSync: jest.fn(actual.execFileSync), spawnSync: jest.fn(actual.spawnSync) };
});

describe('resolveRegistryCredentials', () => {
  let scratch: string;
  let savedPath: string | undefined;

  /** A credential helper as a shell script: `docker-credential-<name>` in `dir`. */
  function helper(dir: string, name: string, body: string): string {
    const file = path.join(dir, `docker-credential-${name}`);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  }

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'registry-auth-')));
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('looks helpers up in exactly the three fixed directories', () => {
    expect(CREDENTIAL_HELPER_DIRS).toEqual([
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/Applications/Docker.app/Contents/Resources/bin',
    ]);
  });

  it('never finds a helper that is only on PATH', async () => {
    // A name nothing installs, so it is in none of the fixed directories.
    const name = `lmtest${process.pid}x${Date.now()}`;
    helper(scratch, name, 'echo \'{"Username":"u","Secret":"s"}\'');
    process.env.PATH = `${scratch}:${savedPath}`;
    const attempt = resolveRegistryCredentials('quay.io', { readConfig: async () => ({ credsStore: name }) });
    await expect(attempt).rejects.toBeInstanceOf(RegistryAuthError);
    await expect(attempt).rejects.toThrow(
      `the Docker credential helper \`docker-credential-${name}\` (from \`credsStore\` in ~/.docker/config.json) ` +
        'was not found in /opt/homebrew/bin, /usr/local/bin or /Applications/Docker.app/Contents/Resources/bin; ' +
        'install it, or remove `credsStore` from ~/.docker/config.json'
    );
  });

  it('names the per-registry key when a credHelpers helper is missing', async () => {
    const attempt = resolveRegistryCredentials('ghcr.io', {
      readConfig: async () => ({ credsStore: 'desktop', credHelpers: { 'ghcr.io': 'nothere' } }),
      helperDirs: [scratch],
    });
    await expect(attempt).rejects.toThrow('`docker-credential-nothere` (from `credHelpers.ghcr.io` in ~/.docker/config.json)');
    await expect(attempt).rejects.toThrow('or remove `credHelpers.ghcr.io` from ~/.docker/config.json');
  });

  it('runs the helper asynchronously and reads its answer', async () => {
    // The helper reads the server URL on stdin, as the credential-helper protocol has it.
    helper(scratch, 'fake', 'read url; printf \'{"ServerURL":"%s","Username":"me","Secret":"s3cret"}\' "$url"');
    const pending = resolveRegistryCredentials('quay.io', {
      readConfig: async () => ({ credsStore: 'fake' }),
      helperDirs: [scratch],
    });
    await expect(pending).resolves.toEqual({ kind: 'basic', username: 'me', password: 's3cret' });
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it('sends the key docker writes the default registry under', async () => {
    helper(scratch, 'echo', 'read url; printf \'{"Username":"%s","Secret":"x"}\' "$url"');
    await expect(
      resolveRegistryCredentials('docker.io', { readConfig: async () => ({ credsStore: 'echo' }), helperDirs: [scratch] })
    ).resolves.toEqual({ kind: 'basic', username: 'https://index.docker.io/v1/', password: 'x' });
  });

  it('takes the first of the fixed directories that has the helper', async () => {
    const first = path.join(scratch, 'a');
    const second = path.join(scratch, 'b');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    helper(second, 'x', 'echo \'{"Username":"second","Secret":"s"}\'');
    await expect(
      resolveRegistryCredentials('quay.io', { readConfig: async () => ({ credsStore: 'x' }), helperDirs: [first, second] })
    ).resolves.toEqual({ kind: 'basic', username: 'second', password: 's' });
  });

  it('carries an identity token as a token', async () => {
    helper(scratch, 'tok', 'echo \'{"Username":"<token>","Secret":"refresh"}\'');
    await expect(
      resolveRegistryCredentials('quay.io', { readConfig: async () => ({ credsStore: 'tok' }), helperDirs: [scratch] })
    ).resolves.toEqual({ kind: 'identity-token', token: 'refresh' });
  });

  it("treats a helper's `credentials not found` as an anonymous pull", async () => {
    helper(scratch, 'none', 'echo "credentials not found in native keychain"; exit 1');
    await expect(
      resolveRegistryCredentials('quay.io', { readConfig: async () => ({ credsStore: 'none' }), helperDirs: [scratch] })
    ).resolves.toBeUndefined();
  });

  it('still uses an inline auths entry when the helper has nothing', async () => {
    helper(scratch, 'none', 'echo "credentials not found in native keychain"; exit 1');
    await expect(
      resolveRegistryCredentials('quay.io', {
        readConfig: async () => ({ credsStore: 'none', auths: { 'quay.io': { auth: Buffer.from('u:p').toString('base64') } } }),
        helperDirs: [scratch],
      })
    ).resolves.toEqual({ kind: 'basic', username: 'u', password: 'p' });
  });

  it('fails loudly, naming the helper, the key and its exit status, on any other helper failure', async () => {
    helper(scratch, 'broken', "echo 'error getting credentials - err: exit status 1, out: `keychain locked`'; exit 1");
    const log = jest.fn<(message: string) => void>();
    const error = await resolveRegistryCredentials('ghcr.io', {
      readConfig: async () => ({ credHelpers: { 'ghcr.io': 'broken' } }),
      helperDirs: [scratch],
      log,
    }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(RegistryAuthError);
    expect((error as Error).message).toBe(
      'the Docker credential helper `docker-credential-broken` (from `credHelpers.ghcr.io` in ~/.docker/config.json) failed: ' +
        "it exited with status 1 (localmost's log has its output); fix it, or remove `credHelpers.ghcr.io` from ~/.docker/config.json"
    );
    // What the helper printed is the operator's: the app log has it, the job's log (this error) does not.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('keychain locked'));
  });

  it('never runs a directory, or a file that is not executable, that is named like the helper', async () => {
    fs.mkdirSync(path.join(scratch, 'docker-credential-adir'));
    fs.writeFileSync(path.join(scratch, 'docker-credential-plain'), '#!/bin/sh\necho \'{"Username":"u","Secret":"s"}\'\n', { mode: 0o644 });
    for (const name of ['adir', 'plain']) {
      await expect(
        resolveRegistryCredentials('quay.io', { readConfig: async () => ({ credsStore: name }), helperDirs: [scratch] })
      ).rejects.toThrow(`\`docker-credential-${name}\` (from \`credsStore\` in ~/.docker/config.json) was not found in ${scratch}`);
    }
  });

  it('refuses an answer larger than 64 KiB', async () => {
    // Valid credential JSON, only too long: 100,000 characters of secret.
    helper(scratch, 'huge', `awk 'BEGIN { s = sprintf("%100000s", ""); gsub(/ /, "a", s); printf "{\\"Username\\":\\"u\\",\\"Secret\\":\\"%s\\"}", s }'`);
    await expect(
      resolveRegistryCredentials('quay.io', { readConfig: async () => ({ credsStore: 'huge' }), helperDirs: [scratch] })
    ).rejects.toThrow('`docker-credential-huge` (from `credsStore` in ~/.docker/config.json) failed: its answer was larger than 64 KiB');
  });

  it('fails loudly when the helper exits 0 without a readable answer', async () => {
    helper(scratch, 'garbled', 'echo "not json"');
    await expect(
      resolveRegistryCredentials('quay.io', { readConfig: async () => ({ credsStore: 'garbled' }), helperDirs: [scratch] })
    ).rejects.toThrow('`docker-credential-garbled` (from `credsStore` in ~/.docker/config.json) failed');
  });

  it('fails loudly when the helper hangs', async () => {
    helper(scratch, 'slow', 'exec sleep 30');
    await expect(
      resolveRegistryCredentials('quay.io', {
        readConfig: async () => ({ credsStore: 'slow' }),
        helperDirs: [scratch],
        timeoutMs: 200,
      })
    ).rejects.toThrow('did not answer within');
  });

  it('strips control characters from what a failing helper printed before it is logged', async () => {
    helper(scratch, 'noisy', 'printf "bad\\033[31m red\\007"; exit 3');
    const log = jest.fn<(message: string) => void>();
    const error = await resolveRegistryCredentials('quay.io', {
      readConfig: async () => ({ credsStore: 'noisy' }),
      helperDirs: [scratch],
      log,
    }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(RegistryAuthError);
    expect((error as Error).message).toContain('it exited with status 3');
    expect((error as Error).message).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('bad');
    expect(log.mock.calls[0][0]).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it('refuses a helper name that is not a plain file name', async () => {
    await expect(
      resolveRegistryCredentials('quay.io', { readConfig: async () => ({ credsStore: '../../bin/sh' }), helperDirs: [scratch] })
    ).rejects.toThrow('`credsStore` in ~/.docker/config.json does not name a credential helper localmost can run');
  });

  it('uses inline auths unchanged, including identity tokens', async () => {
    await expect(
      resolveRegistryCredentials('quay.io', {
        readConfig: async () => ({ auths: { 'https://quay.io': { auth: Buffer.from('user:pa:ss').toString('base64') } } }),
      })
    ).resolves.toEqual({ kind: 'basic', username: 'user', password: 'pa:ss' });
    await expect(
      resolveRegistryCredentials('docker.io', {
        readConfig: async () => ({ auths: { 'https://index.docker.io/v1/': { identitytoken: 'it' } } }),
      })
    ).resolves.toEqual({ kind: 'identity-token', token: 'it' });
  });

  it('is anonymous with no config, and with nothing configured for the registry', async () => {
    await expect(resolveRegistryCredentials('quay.io', { readConfig: async () => null })).resolves.toBeUndefined();
    await expect(
      resolveRegistryCredentials('quay.io', { readConfig: async () => ({ auths: { 'ghcr.io': { auth: 'dTpw' } } }) })
    ).resolves.toBeUndefined();
  });

  it('reads the config file, is anonymous without one, and refuses one that is not JSON', async () => {
    // Never the operator's own config: its helper may reach the real keychain.
    const configFile = path.join(scratch, 'config.json');
    await expect(resolveRegistryCredentials('quay.io', { configFile })).resolves.toBeUndefined();
    fs.writeFileSync(configFile, JSON.stringify({ auths: { 'quay.io': { auth: Buffer.from('a:b').toString('base64') } } }));
    await expect(resolveRegistryCredentials('quay.io', { configFile })).resolves.toEqual({
      kind: 'basic',
      username: 'a',
      password: 'b',
    });
    fs.writeFileSync(configFile, '{ not json');
    await expect(resolveRegistryCredentials('quay.io', { configFile })).rejects.toThrow(
      '~/.docker/config.json is not valid JSON'
    );
  });
});
