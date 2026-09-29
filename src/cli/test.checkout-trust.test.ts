/**
 * What `localmost test` lets a checkout grant itself before anyone agrees.
 *
 * A checkout's .localmostrc is its own to write, and so is its workflow.
 * Applied without asking, a policy with `filesystem.write:
 * ['~/Library/LaunchAgents']` let one step leave a plist launchd runs,
 * unsandboxed, at the next login; `read: ['~/**']` with any allowed host
 * sent the user's documents away. These hold the run until the user has
 * seen what the checkout asks for.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { checkoutLoopback, confirmCheckoutGrants, grantsBeyondWorkspace, runTest } from './test';
import { MACOS_BASELINE_READ_PATHS } from '../shared/sandbox-profile';
import type { LocalmostrcConfig } from '../shared/localmostrc';

let scratch: string;
let checkout: string;
const savedConfigDir = process.env.LOCALMOST_CONFIG_DIR;

beforeEach(() => {
  const build = path.join(process.cwd(), 'build');
  fs.mkdirSync(build, { recursive: true });
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(build, 'checkout-trust-')));
  process.env.LOCALMOST_CONFIG_DIR = path.join(scratch, 'appdata');
  checkout = path.join(scratch, 'checkout');
  fs.mkdirSync(checkout);
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
  else process.env.LOCALMOST_CONFIG_DIR = savedConfigDir;
  fs.rmSync(scratch, { recursive: true, force: true });
});

const launchAgents = { filesystem: { write: ['~/Library/LaunchAgents'] } };

describe('grantsBeyondWorkspace', () => {
  it('lists every write, every read past the OS baseline, and every host', () => {
    expect(
      grantsBeyondWorkspace({
        filesystem: { read: [...MACOS_BASELINE_READ_PATHS, '~/**'], write: ['~/.zshrc'] },
        network: { allow: ['attacker.example'] },
      })
    ).toEqual([
      { label: 'filesystem.write', items: ['~/.zshrc'] },
      { label: 'filesystem.read', items: ['~/**'] },
      { label: 'network.allow', items: ['attacker.example'] },
    ]);
  });

  it('is empty for a policy that stays in the workspace and the OS', () => {
    expect(grantsBeyondWorkspace({ filesystem: { read: MACOS_BASELINE_READ_PATHS } })).toEqual([]);
    expect(grantsBeyondWorkspace(undefined)).toEqual([]);
  });

  it('lists loopback beyond the proxy, which reaches the services this machine runs', () => {
    expect(grantsBeyondWorkspace(undefined, [5432, 6379])).toEqual([
      { label: 'network.loopback', items: ['port 5432 on this machine', 'port 6379 on this machine'] },
    ]);
    expect(grantsBeyondWorkspace(undefined, true)).toEqual([
      { label: 'network.loopback', items: ['every port on this machine: any local service'] },
    ]);
  });
});

describe('checkoutLoopback', () => {
  // As a parsed .localmostrc holds it; the schema types network.loopback.
  const withNetwork = (where: 'shared' | 'workflow', network: Record<string, unknown>) =>
    (where === 'shared'
      ? { version: 1, shared: { network } }
      : { version: 1, workflows: { CI: { network } } }) as unknown as LocalmostrcConfig;

  it('is the shared grant: every port, or whole port numbers', () => {
    expect(checkoutLoopback(withNetwork('shared', { loopback: true }))).toBe(true);
    expect(checkoutLoopback(withNetwork('shared', { loopback: [5432, 6379] }))).toEqual([5432, 6379]);
    expect(checkoutLoopback(withNetwork('shared', { allow: ['github.com'] }))).toBeUndefined();
    expect(checkoutLoopback(undefined)).toBeUndefined();
  });

  it('grants nothing from a value that is not a grant', () => {
    // The schema refuses these; this is what runs if one reaches it anyway.
    for (const loopback of [false, 'yes', '*', [5432, 0], [65536], [1.5], ['5432'], [5432, 5432], []]) {
      expect({ loopback, grant: checkoutLoopback(withNetwork('shared', { loopback })) }).toEqual({
        loopback,
        grant: undefined,
      });
    }
  });

  it('never takes a per-workflow grant', () => {
    expect(checkoutLoopback(withNetwork('workflow', { loopback: true }))).toBeUndefined();
  });
});

describe('confirmCheckoutGrants', () => {
  const grants = grantsBeyondWorkspace(launchAgents);

  it('refuses without a terminal to ask on, unless --yes was passed', async () => {
    const ask = jest.fn(async () => 'y');
    expect(await confirmCheckoutGrants(checkout, grants, { assumeYes: false, isTTY: false, ask })).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    expect(await confirmCheckoutGrants(checkout, grants, { assumeYes: true, isTTY: false, ask })).toBe(true);
  });

  it('asks on a terminal, and remembers a yes for this checkout and these grants only', async () => {
    const no = jest.fn(async () => 'n');
    expect(await confirmCheckoutGrants(checkout, grants, { assumeYes: false, isTTY: true, ask: no })).toBe(false);
    expect(no).toHaveBeenCalledTimes(1);

    const yes = jest.fn(async () => 'y');
    expect(await confirmCheckoutGrants(checkout, grants, { assumeYes: false, isTTY: true, ask: yes })).toBe(true);
    const never = jest.fn(async () => 'n');
    expect(await confirmCheckoutGrants(checkout, grants, { assumeYes: false, isTTY: false, ask: never })).toBe(true);
    expect(never).not.toHaveBeenCalled();

    // Anything more - or the same grants from another checkout - is asked again.
    const more = grantsBeyondWorkspace({ filesystem: { write: ['~/Library/LaunchAgents', '~/.zshrc'] } });
    expect(await confirmCheckoutGrants(checkout, more, { assumeYes: false, isTTY: false, ask: never })).toBe(false);
    const other = path.join(scratch, 'other');
    fs.mkdirSync(other);
    expect(await confirmCheckoutGrants(other, grants, { assumeYes: false, isTTY: false, ask: never })).toBe(false);
  });

  it('asks nothing when the policy grants nothing beyond the workspace', async () => {
    const ask = jest.fn(async () => 'n');
    expect(await confirmCheckoutGrants(checkout, [], { assumeYes: false, isTTY: false, ask })).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('runTest on a checkout that grants itself more than its workspace', () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    fs.mkdirSync(path.join(checkout, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(checkout, '.github', 'workflows', 'ci.yml'),
      'name: CI\non: push\njobs:\n  build:\n    runs-on: macos-latest\n    steps:\n      - run: echo hi\n'
    );
    process.chdir(checkout);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    jest.mocked(console.log).mockRestore();
  });

  it('does not apply a policy that writes outside the workspace without confirmation', async () => {
    fs.writeFileSync(
      path.join(checkout, '.localmostrc'),
      'version: 1\nshared:\n  filesystem:\n    write:\n      - ~/Library/LaunchAgents\n'
    );
    // Jest's stdin is not a terminal, and --yes was not passed.
    await expect(runTest({})).rejects.toThrow(/--yes/);
    expect(fs.existsSync(path.join(scratch, 'appdata', 'workspaces'))).toBe(false);
  });

  it('does not open loopback to a checkout without confirmation', async () => {
    fs.writeFileSync(path.join(checkout, '.localmostrc'), 'version: 1\nshared:\n  network:\n    loopback: true\n');
    await expect(runTest({})).rejects.toThrow(/--yes/);
    expect(fs.existsSync(path.join(scratch, 'appdata', 'workspaces'))).toBe(false);
  });

  it('does not run discovery, which reads the whole disk, without confirmation', async () => {
    await expect(runTest({ updaterc: true })).rejects.toThrow(/--yes/);
    expect(fs.existsSync(path.join(scratch, 'appdata', 'workspaces'))).toBe(false);
  });
});
