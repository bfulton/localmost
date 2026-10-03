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

import * as yaml from 'js-yaml';
import { loadPersistedConfig, savePersistedConfig } from './persist';
import { store, runnerJobEnvironment, runnerResourcePause } from '../index';
import { defaultConfigState } from '../types';
import { CONFIG_VERSION, type AppConfig } from '../../config';
import type { GitHubUser } from '../../../shared/types';

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

const SPENT_SESSION_CONFIG = `configVersion: 1
theme: auto
auth:
  refreshToken: enc:spent
  user:
    login: bfulton
  expired: true
`;

describe('savePersistedConfig auth preservation', () => {
  it('carries a spent session forward when an unrelated setting is persisted', () => {
    // saveConfig records `expired`. This writer runs on every config change,
    // on the startup targets write and on quit, and rebuilt auth from the
    // refresh token and user alone - so the next launch forgot the session
    // was spent and went back to refreshing a token that can never work.
    fs.writeFileSync(configPath, SPENT_SESSION_CONFIG);
    loadPersistedConfig();

    store.setState({ config: { ...store.getState().config, theme: 'dark' } });
    savePersistedConfig();

    const saved = yaml.load(fs.readFileSync(configPath, 'utf-8')) as AppConfig;
    expect(saved.theme).toBe('dark');
    expect(saved.auth).toEqual({ refreshToken: 'enc:spent', user: { login: 'bfulton' }, expired: true });
  });

  it('does not invent the flag for a healthy session', () => {
    fs.writeFileSync(configPath, SPENT_SESSION_CONFIG.replace('  expired: true\n', ''));
    loadPersistedConfig();

    store.setState({ config: { ...store.getState().config, theme: 'dark' } });
    savePersistedConfig();

    const saved = yaml.load(fs.readFileSync(configPath, 'utf-8')) as AppConfig;
    // Still an allowlist: a legacy access token on disk is not revived either.
    expect(saved.auth).toEqual({ refreshToken: 'enc:spent', user: { login: 'bfulton' } });
  });
});

describe('the resource-pause and job-environment preferences', () => {
  it('start at their defaults: running jobs finish, every convenience on, the Swift Build link-temp grant off', () => {
    loadPersistedConfig();
    expect(store.getState().config.resourcePause).toEqual({ runningJobs: 'finish' });
    expect(store.getState().config.jobEnvironment).toEqual({
      toolShims: true,
      javaToolOptions: true,
      perJobTempDir: true,
      createMissingGrantedDirs: true,
      swiftBuildLinkTemp: false,
    });
  });

  it('load from config.yaml and persist back, so a save at quit keeps them', () => {
    // The store loads both sections from the file at launch, so a save that
    // dropped them would quietly undo the setting at the next one.
    fs.writeFileSync(
      configPath,
      [
        'configVersion: 1',
        'theme: auto',
        'resourcePause:',
        '  runningJobs: stop',
        'jobEnvironment:',
        '  toolShims: false',
        '  perJobTempDir: false',
        '',
      ].join('\n')
    );
    loadPersistedConfig();

    expect(store.getState().config.resourcePause).toEqual({ runningJobs: 'stop' });
    expect(store.getState().config.jobEnvironment).toEqual({
      toolShims: false,
      javaToolOptions: true,
      perJobTempDir: false,
      createMissingGrantedDirs: true,
      swiftBuildLinkTemp: false,
    });

    store.getState().setJobEnvironment({ ...store.getState().config.jobEnvironment, javaToolOptions: false });
    savePersistedConfig();

    const saved = yaml.load(fs.readFileSync(configPath, 'utf-8')) as AppConfig;
    expect(saved.resourcePause).toEqual({ runningJobs: 'stop' });
    expect(saved.jobEnvironment).toEqual({
      toolShims: false,
      javaToolOptions: false,
      perJobTempDir: false,
      createMissingGrantedDirs: true,
      swiftBuildLinkTemp: false,
    });

    // And back again, as the next launch reads it.
    store.setState({ config: { ...defaultConfigState } });
    loadPersistedConfig();
    expect(store.getState().config.resourcePause).toEqual({ runningJobs: 'stop' });
    expect(store.getState().config.jobEnvironment.javaToolOptions).toBe(false);
  });

  it("keep the Swift Build link-temp grant off unless the file turns it on, and persist it turned on", () => {
    fs.writeFileSync(configPath, 'configVersion: 1\ntheme: auto\njobEnvironment:\n  swiftBuildLinkTemp: true\n');
    loadPersistedConfig();
    expect(store.getState().config.jobEnvironment.swiftBuildLinkTemp).toBe(true);
    expect(runnerJobEnvironment().swiftBuildLinkTemp).toBe(true);

    savePersistedConfig();
    const saved = yaml.load(fs.readFileSync(configPath, 'utf-8')) as AppConfig;
    expect(saved.jobEnvironment).toEqual(expect.objectContaining({ swiftBuildLinkTemp: true, toolShims: true }));

    store.getState().setJobEnvironment({ ...store.getState().config.jobEnvironment, swiftBuildLinkTemp: false });
    savePersistedConfig();
    store.setState({ config: { ...defaultConfigState } });
    loadPersistedConfig();
    expect(store.getState().config.jobEnvironment.swiftBuildLinkTemp).toBe(false);
  });

  it('take a value the runner would not as its default, as the runner does', () => {
    fs.writeFileSync(
      configPath,
      'configVersion: 1\ntheme: auto\nresourcePause:\n  runningJobs: kill\njobEnvironment:\n  toolShims: "no"\n  javaToolOptions: false\n'
    );
    loadPersistedConfig();

    expect(store.getState().config.resourcePause).toEqual({ runningJobs: 'finish' });
    expect(store.getState().config.jobEnvironment).toEqual({
      toolShims: true,
      javaToolOptions: false,
      perJobTempDir: true,
      createMissingGrantedDirs: true,
      swiftBuildLinkTemp: false,
    });
  });
});

describe("the runner's resource-pause and job-environment preferences", () => {
  it('are the ones Settings shows, whatever is written to config.yaml while the app runs', () => {
    // The store owns both sections: the page shows the store's value, and
    // every save writes it back over the file. The runner read the file at
    // each pause and spawn instead, so a hand edit made while the app ran
    // took effect for the next job, the page went on showing the old value,
    // and the next save put the old value back.
    fs.writeFileSync(
      configPath,
      'configVersion: 1\ntheme: auto\nresourcePause:\n  runningJobs: stop\njobEnvironment:\n  toolShims: false\n'
    );
    loadPersistedConfig();
    expect(runnerResourcePause()).toEqual({ runningJobs: 'stop' });
    expect(runnerJobEnvironment()).toEqual({
      toolShims: false,
      javaToolOptions: true,
      perJobTempDir: true,
      createMissingGrantedDirs: true,
      swiftBuildLinkTemp: false,
    });

    fs.writeFileSync(
      configPath,
      'configVersion: 1\ntheme: auto\nresourcePause:\n  runningJobs: finish\njobEnvironment:\n  toolShims: true\n  javaToolOptions: false\n'
    );
    expect(runnerResourcePause()).toEqual(store.getState().config.resourcePause);
    expect(runnerResourcePause()).toEqual({ runningJobs: 'stop' });
    expect(runnerJobEnvironment()).toEqual(store.getState().config.jobEnvironment);
    expect(runnerJobEnvironment().toolShims).toBe(false);
    expect(runnerJobEnvironment().javaToolOptions).toBe(true);

    // A change made in Settings reaches the runner at once.
    store.getState().setResourcePause({ runningJobs: 'finish' });
    store.getState().setJobEnvironment({ ...store.getState().config.jobEnvironment, perJobTempDir: false });
    expect(runnerResourcePause()).toEqual({ runningJobs: 'finish' });
    expect(runnerJobEnvironment().perJobTempDir).toBe(false);
  });
});

describe('sections only config.yaml holds', () => {
  it('carries them forward when the store persists, as written', () => {
    // The store does not hold these: the Docker VM sizes, the update check
    // and the OAuth client are read from the file. This writer rebuilt the
    // file from the store alone on every config change and at quit, so a
    // dockerVm section written by hand was gone the next time the app quit.
    fs.writeFileSync(
      configPath,
      [
        'configVersion: 1',
        'theme: auto',
        'githubClientId: Iv1.custom',
        'updateSettings:',
        '  autoCheck: false',
        '  checkIntervalHours: 24',
        'dockerVm:',
        '  cpus: 2',
        '  memoryMiB: 4096',
        '  prewarm: maybe',
        '',
      ].join('\n')
    );
    loadPersistedConfig();

    store.setState({ config: { ...store.getState().config, theme: 'dark' } });
    savePersistedConfig();

    const saved = yaml.load(fs.readFileSync(configPath, 'utf-8')) as AppConfig;
    expect(saved.theme).toBe('dark');
    expect(saved.githubClientId).toBe('Iv1.custom');
    expect(saved.updateSettings).toEqual({ autoCheck: false, checkIntervalHours: 24 });
    // Even a value the VM backend would refuse: the file is the user's, and
    // resolveDockerVmConfig says what it makes of it.
    expect(saved.dockerVm).toEqual({ cpus: 2, memoryMiB: 4096, prewarm: 'maybe' });
  });

  it('writes none of them where the file had none', () => {
    fs.writeFileSync(configPath, 'configVersion: 1\ntheme: auto\n');
    loadPersistedConfig();
    savePersistedConfig();

    const saved = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(saved).not.toHaveProperty('dockerVm');
    expect(saved).not.toHaveProperty('updateSettings');
    expect(saved).not.toHaveProperty('githubClientId');
  });
});

describe('every key of config.yaml', () => {
  it('survives a load and a save, whichever part of the app owns it', () => {
    // The store's save rebuilds the file from what it owns, plus what it is
    // told the file alone holds. dockerVm was added to AppConfig without
    // telling it, and every save dropped the section. Required<AppConfig>:
    // tsc refuses this fixture until a key AppConfig gains is added here, and
    // the save then has to keep it.
    const full: Required<AppConfig> = {
      configVersion: CONFIG_VERSION,
      githubClientId: 'Iv1.custom',
      auth: { refreshToken: 'enc:refresh', user: { login: 'octocat' } as GitHubUser, expired: true },
      runnerConfig: {
        level: 'org',
        repoUrl: 'https://github.com/octocat/hello',
        orgName: 'octo-org',
        runnerName: 'mac',
        labels: 'self-hosted,macOS',
        runnerCount: 3,
      },
      theme: 'dark',
      launchAtLogin: true,
      hideOnStart: true,
      sleepProtection: 'always',
      logLevel: 'debug',
      runnerLogLevel: 'warn',
      userFilter: { scope: 'trigger', allowedUsers: 'allowlist', allowlist: [] },
      updateSettings: { autoCheck: false, checkIntervalHours: 12 },
      targets: [
        {
          id: 'abc123',
          type: 'repo',
          owner: 'octocat',
          repo: 'hello',
          displayName: 'octocat/hello',
          url: 'https://github.com/octocat/hello',
          proxyRunnerName: 'localmost.host.octocat-hello',
          enabled: true,
          addedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      maxConcurrentJobs: 2,
      power: { pauseOnBattery: 'always', pauseOnVideoCall: true, videoCallGracePeriod: 30 },
      notifications: { notifyOnPause: true, notifyOnJobEvents: true },
      dockerVm: { cpus: 2, memoryMiB: 4096 },
      resourcePause: { runningJobs: 'stop' },
      jobEnvironment: { toolShims: false, javaToolOptions: true, perJobTempDir: false, createMissingGrantedDirs: true, swiftBuildLinkTemp: false },
    };
    fs.writeFileSync(configPath, yaml.dump(full));
    loadPersistedConfig();

    store.getState().setTheme('light');
    savePersistedConfig();

    const saved = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    for (const key of Object.keys(full) as Array<keyof AppConfig>) {
      expect([key, saved[key]]).toEqual([key, key === 'theme' ? 'light' : full[key]]);
    }
  });
});

describe('the removed preserveWorkDir setting', () => {
  it('ignores a value an earlier build saved, and drops it at the next save', () => {
    // Not an error: the rest of the file loads as before, and the setting
    // simply no longer exists.
    fs.writeFileSync(configPath, 'configVersion: 1\ntheme: dark\npreserveWorkDir: always\n');
    loadPersistedConfig();

    expect(store.getState().config.theme).toBe('dark');
    expect(store.getState().config).not.toHaveProperty('preserveWorkDir');

    savePersistedConfig();
    const saved = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(saved.theme).toBe('dark');
    expect(saved).not.toHaveProperty('preserveWorkDir');
  });
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
