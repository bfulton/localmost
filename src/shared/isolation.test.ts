import { describe, it, expect, jest } from '@jest/globals';
import {
  ANY_ISOLATION,
  DEFAULT_ISOLATION_CONFIG,
  ISOLATION_TYPES,
  availableIsolationTypes,
  isolationDeclarationProblems,
  isolationList,
  resolveIsolationConfig,
  selectIsolation,
} from './isolation';

describe('isolation types', () => {
  it('are seatbelt, service-account and macos-vm, and any means all three, strongest first', () => {
    expect(ISOLATION_TYPES).toEqual(['seatbelt', 'service-account', 'macos-vm']);
    expect(ANY_ISOLATION).toEqual(['macos-vm', 'service-account', 'seatbelt']);
  });

  it('this build can run seatbelt alone', () => {
    expect(availableIsolationTypes()).toEqual(['seatbelt']);
  });
});

describe('isolationList', () => {
  it('reads an absent declaration as any', () => {
    expect(isolationList(undefined)).toEqual(['macos-vm', 'service-account', 'seatbelt']);
    expect(isolationList('any')).toEqual(['macos-vm', 'service-account', 'seatbelt']);
  });

  it('reads a single type as a one-item list, and keeps a list in its order', () => {
    expect(isolationList('seatbelt')).toEqual(['seatbelt']);
    expect(isolationList(['seatbelt', 'macos-vm'])).toEqual(['seatbelt', 'macos-vm']);
    expect(isolationList(['macos-vm', 'seatbelt'])).toEqual(['macos-vm', 'seatbelt']);
  });
});

describe('isolationDeclarationProblems', () => {
  const problems = (value: unknown) => isolationDeclarationProblems(value, 'shared.isolation');

  it('accepts any, a single type, and a list of distinct types, those not built yet included', () => {
    for (const value of ['any', 'seatbelt', 'macos-vm', 'service-account', ['macos-vm'], ['macos-vm', 'service-account', 'seatbelt']]) {
      expect({ value, problems: problems(value) }).toEqual({ value, problems: [] });
    }
  });

  it('refuses an unknown type, naming the accepted ones', () => {
    expect(problems('docker')).toEqual([
      'shared.isolation: "docker" is not an isolation type. Accepted: seatbelt, service-account, macos-vm, or any.',
    ]);
    expect(problems(['seatbelt', 'vm'])).toEqual([
      'shared.isolation[1]: "vm" is not an isolation type. Accepted: seatbelt, service-account, macos-vm.',
    ]);
  });

  it('refuses a type listed twice', () => {
    expect(problems(['seatbelt', 'macos-vm', 'seatbelt'])).toEqual(['shared.isolation lists seatbelt twice']);
  });

  it('refuses any inside a list, an empty list, and anything but a string or a list of strings', () => {
    expect(problems(['any'])).toEqual([
      'shared.isolation[0]: "any" stands alone: write isolation: any, or list the types in order.',
    ]);
    expect(problems([])).toEqual(['shared.isolation must list at least one isolation type, or be any']);
    for (const value of [true, 3, null, { seatbelt: true }]) {
      expect(problems(value)).toEqual([
        'shared.isolation must be any, an isolation type, or a list of them in the order to try',
      ]);
    }
    expect(problems([1])).toEqual(['shared.isolation[0] must be an isolation type']);
  });
});

describe('selectIsolation', () => {
  const allowedHere = DEFAULT_ISOLATION_CONFIG.allowed;
  const available = availableIsolationTypes();

  it('picks seatbelt for the default policy (any) on a Mac at its defaults', () => {
    expect(selectIsolation(isolationList(undefined), allowedHere, available)).toEqual({ type: 'seatbelt' });
  });

  it("walks the policy's list in its order, taking the first type this Mac both allows and can run", () => {
    expect(selectIsolation(['macos-vm', 'seatbelt'], allowedHere, available)).toEqual({ type: 'seatbelt' });
    // The policy's order, not the host's: both allowed and available, the policy's first wins.
    expect(selectIsolation(['service-account', 'seatbelt'], ['seatbelt', 'service-account'], ['seatbelt', 'service-account'])).toEqual({
      type: 'service-account',
    });
    expect(selectIsolation(['seatbelt', 'service-account'], ['service-account', 'seatbelt'], ['seatbelt', 'service-account'])).toEqual({
      type: 'seatbelt',
    });
  });

  it('refuses a policy that accepts only what this build cannot run, saying what each side holds', () => {
    expect(selectIsolation(['macos-vm'], allowedHere, available)).toEqual({
      refusal: 'this repository accepts macos-vm; this Mac allows seatbelt; macos-vm is not available in this build',
    });
    expect(selectIsolation(['macos-vm', 'service-account'], allowedHere, available)).toEqual({
      refusal:
        'this repository accepts macos-vm, service-account; this Mac allows seatbelt; ' +
        'macos-vm and service-account are not available in this build',
    });
  });

  it('refuses rather than downgrade when this Mac allows none of what the policy accepts', () => {
    expect(selectIsolation(['seatbelt'], [], available)).toEqual({
      refusal: 'this repository accepts seatbelt; this Mac allows none; seatbelt is not allowed in Settings > Isolation',
    });
    // Allowed but not built does not count either.
    expect(selectIsolation(['seatbelt'], ['macos-vm'], available)).toEqual({
      refusal: 'this repository accepts seatbelt; this Mac allows macos-vm; seatbelt is not allowed in Settings > Isolation',
    });
  });
});

describe('resolveIsolationConfig', () => {
  it('allows seatbelt alone by default', () => {
    expect(DEFAULT_ISOLATION_CONFIG).toEqual({ allowed: ['seatbelt'] });
    expect(resolveIsolationConfig(undefined)).toEqual({ allowed: ['seatbelt'] });
    expect(resolveIsolationConfig({})).toEqual({ allowed: ['seatbelt'] });
  });

  it('cannot be changed through the default', () => {
    expect(() => {
      (DEFAULT_ISOLATION_CONFIG.allowed as string[]).push('macos-vm');
    }).toThrow(TypeError);
    const resolved = resolveIsolationConfig(undefined);
    resolved.allowed.push('macos-vm');
    expect(DEFAULT_ISOLATION_CONFIG.allowed).toEqual(['seatbelt']);
  });

  it('keeps a list of known types, none included, in its order', () => {
    expect(resolveIsolationConfig({ allowed: [] })).toEqual({ allowed: [] });
    expect(resolveIsolationConfig({ allowed: ['macos-vm', 'seatbelt'] })).toEqual({ allowed: ['macos-vm', 'seatbelt'] });
  });

  it('drops an unknown or repeated type, and takes anything but a list as the default, saying so', () => {
    const log = jest.fn();
    expect(resolveIsolationConfig({ allowed: ['seatbelt', 'docker', 'seatbelt'] }, log)).toEqual({ allowed: ['seatbelt'] });
    expect(log).toHaveBeenCalledWith('isolation.allowed: ignoring "docker", which is not an isolation type');
    expect(log).toHaveBeenCalledWith('isolation.allowed: ignoring seatbelt listed twice');
    log.mockClear();
    expect(resolveIsolationConfig({ allowed: 'seatbelt' }, log)).toEqual({ allowed: ['seatbelt'] });
    expect(log).toHaveBeenCalledWith('isolation.allowed must be a list of isolation types; using seatbelt');
  });
});
