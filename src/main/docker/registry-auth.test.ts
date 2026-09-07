import { describe, it, expect, jest } from '@jest/globals';
import { resolveRegistryAuth, RegistryAuthDeps } from './registry-auth';

const decode = (header: string | undefined) =>
  header === undefined ? undefined : JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));

const deps = (over: Partial<RegistryAuthDeps>): RegistryAuthDeps => ({
  readConfig: () => null,
  runHelper: () => null,
  ...over,
});

describe('resolveRegistryAuth', () => {
  it('uses the credential store, which is how Docker Desktop keeps secrets', () => {
    const runHelper = jest.fn(() => ({ ServerURL: 'quay.io', Username: 'me', Secret: 's3cret' }));
    const header = resolveRegistryAuth('quay.io', deps({
      readConfig: () => ({ credsStore: 'desktop', auths: { 'quay.io': {} } }),
      runHelper: runHelper as RegistryAuthDeps['runHelper'],
    }));
    expect(runHelper).toHaveBeenCalledWith('desktop', 'quay.io');
    expect(decode(header)).toEqual({ username: 'me', password: 's3cret', serveraddress: 'quay.io' });
  });

  it('prefers a per-registry helper over the general store', () => {
    const runHelper = jest.fn(() => ({ Username: 'x', Secret: 'y' }));
    resolveRegistryAuth('quay.io', deps({
      readConfig: () => ({ credsStore: 'desktop', credHelpers: { 'quay.io': 'ecr-login' } }),
      runHelper: runHelper as RegistryAuthDeps['runHelper'],
    }));
    expect(runHelper).toHaveBeenCalledWith('ecr-login', 'quay.io');
  });

  it('reads the default registry under the key docker writes it as', () => {
    const runHelper = jest.fn(() => ({ Username: 'me', Secret: 'p' }));
    resolveRegistryAuth('docker.io', deps({
      readConfig: () => ({ credsStore: 'desktop' }),
      runHelper: runHelper as RegistryAuthDeps['runHelper'],
    }));
    expect(runHelper).toHaveBeenCalledWith('desktop', 'https://index.docker.io/v1/');
  });

  it('falls back to an inline auths entry', () => {
    const header = resolveRegistryAuth('quay.io', deps({
      readConfig: () => ({ auths: { 'quay.io': { auth: Buffer.from('user:pass').toString('base64') } } }),
    }));
    expect(decode(header)).toEqual({ username: 'user', password: 'pass', serveraddress: 'quay.io' });
  });

  it('carries an identity token as a token, not as a password', () => {
    const header = resolveRegistryAuth('quay.io', deps({
      readConfig: () => ({ credsStore: 'desktop' }),
      runHelper: () => ({ Username: '<token>', Secret: 'tok' }),
    }));
    expect(decode(header)).toEqual({ identitytoken: 'tok', serveraddress: 'quay.io' });
  });

  it('returns nothing rather than throwing when there is no credential', () => {
    expect(resolveRegistryAuth('quay.io', deps({}))).toBeUndefined();
    expect(resolveRegistryAuth('quay.io', deps({ readConfig: () => ({ credsStore: 'desktop' }) }))).toBeUndefined();
    expect(resolveRegistryAuth('quay.io', deps({ readConfig: () => ({ auths: { 'quay.io': { auth: 'not-base64-pair' } } }) }))).toBeUndefined();
  });
});
