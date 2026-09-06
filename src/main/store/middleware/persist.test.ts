import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-'));
const configPath = path.join(tmpRoot, 'config.yaml');

jest.mock('../../paths', () => ({
  getAppDataDir: () => tmpRoot,
  getConfigPath: () => configPath,
}));

jest.mock('../../log-file', () => ({
  bootLog: jest.fn(),
}));

import { loadPersistedConfig, savePersistedConfig } from './persist';
import { store } from '../index';
import { defaultConfigState } from '../types';

const GOOD_CONFIG = `theme: auto
hideOnStart: true
targets:
  - id: abc123
    type: repo
    owner: octocat
    repo: hello
    displayName: octocat/hello
    url: https://github.com/octocat/hello
    proxyRunnerName: localmost.host.octocat-hello
    enabled: true
    addedAt: '2026-01-01T00:00:00.000Z'
`;

beforeEach(() => {
  // Reset the shared store's config slice between tests.
  store.setState({ config: { ...defaultConfigState } });
  if (fs.existsSync(configPath)) fs.rmSync(configPath);
  const tmp = `${configPath}.tmp`;
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('savePersistedConfig hydration guard', () => {
  it('does not overwrite an existing config that failed to parse', () => {
    // A truncated/empty file is exactly what an interrupted write leaves behind.
    fs.writeFileSync(configPath, '');

    loadPersistedConfig();
    savePersistedConfig();

    // The guard must refuse to stamp factory defaults over the damaged file,
    // so a human or backup can still recover it. Overwriting it would erase
    // the evidence and make the loss permanent.
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('');
  });

  it('persists normally on a genuine fresh install (no file yet)', () => {
    // No file on disk is not a failed load — it is first run. Blocking saves
    // here would mean settings never persist.
    loadPersistedConfig();
    store.setState({ config: { ...store.getState().config, theme: 'dark' } });
    savePersistedConfig();

    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(configPath, 'utf-8')).toContain('theme: dark');
  });

  it('hydrates targets from a valid file and persists them back', () => {
    fs.writeFileSync(configPath, GOOD_CONFIG);

    loadPersistedConfig();
    expect(store.getState().config.targets).toHaveLength(1);

    savePersistedConfig();
    expect(fs.readFileSync(configPath, 'utf-8')).toContain('proxyRunnerName: localmost.host.octocat-hello');
  });

  it('refuses to overwrite a config written by a newer build', () => {
    fs.writeFileSync(configPath, 'configVersion: 999999\ntheme: dark\ntargets: []\n');

    loadPersistedConfig();
    savePersistedConfig();

    expect(fs.readFileSync(configPath, 'utf-8')).toContain('configVersion: 999999');
  });

  it('stamps a config version when it does persist', () => {
    loadPersistedConfig();
    store.setState({ config: { ...store.getState().config, theme: 'dark' } });
    savePersistedConfig();

    expect(fs.readFileSync(configPath, 'utf-8')).toContain('configVersion:');
  });
});
