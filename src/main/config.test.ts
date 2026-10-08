import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-'));
const configPath = path.join(tmpRoot, 'config.yaml');

jest.mock('./paths', () => ({
  getAppDataDir: () => tmpRoot,
  getConfigPath: () => configPath,
}));

jest.mock('./log-file', () => ({
  bootLog: jest.fn(),
}));

jest.mock('./encryption', () => ({
  encryptValue: (v: string) => `enc:${v}`,
  decryptValue: (v: string) => v.replace(/^enc:/, ''),
}));

import {
  saveConfig,
  loadConfig,
  resolveDockerVmConfig,
  resolveResourcePauseConfig,
  DockerVmConfigSource,
  SETTABLE_CONFIG_KEYS,
} from './config';

beforeEach(() => {
  if (fs.existsSync(configPath)) fs.rmSync(configPath);
  const tmp = `${configPath}.tmp`;
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('saveConfig', () => {
  it('round-trips a config through disk', () => {
    saveConfig({ theme: 'dark' });
    expect(loadConfig().theme).toBe('dark');
  });

  it('remembers that a session is spent, across a restart', async () => {
    // saveConfig rebuilds auth from refreshToken and user, so the expired flag
    // was dropped on every write. A restart then loaded the session as healthy
    // and went back to refreshing a token that can never work - and the app
    // presented an account it could not act as.
    saveConfig({ auth: { refreshToken: 'spent', user: { login: 'bfulton' } as never, expired: true } });

    expect(loadConfig().auth?.expired).toBe(true);
  });

  it('does not invent the flag for a healthy session', () => {
    saveConfig({ auth: { refreshToken: 'good', user: { login: 'bfulton' } as never } });

    expect(loadConfig().auth?.expired).toBeUndefined();
  });

  it('leaves no temp file behind after a successful save', () => {
    saveConfig({ theme: 'light' });
    expect(fs.existsSync(`${configPath}.tmp`)).toBe(false);
  });

  it('preserves the existing config when the write cannot complete', () => {
    saveConfig({ theme: 'dark' });
    const before = fs.readFileSync(configPath, 'utf-8');

    // Block the atomic write's temp path so the write throws before it can
    // replace the real file. A truncate-in-place write would already have
    // destroyed the good config by this point.
    fs.mkdirSync(`${configPath}.tmp`);

    saveConfig({ theme: 'light' });

    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('stamps a numeric config version on save', () => {
    saveConfig({ theme: 'dark' });
    expect(typeof loadConfig().configVersion).toBe('number');
  });

  it('refuses to save over a config written by a newer build', () => {
    // A stale or older app bundle sharing the same config dir must not be able
    // to downgrade a config written by a newer one — that is how the real
    // targets loss happened.
    fs.writeFileSync(configPath, 'configVersion: 999999\ntheme: dark\n');

    saveConfig({ theme: 'light' });

    expect(fs.readFileSync(configPath, 'utf-8')).toContain('configVersion: 999999');
  });
});

describe('SETTABLE_CONFIG_KEYS', () => {
  it('leaves out what only the main process writes: the session, and the targets', () => {
    expect(SETTABLE_CONFIG_KEYS).not.toContain('auth');
    expect(SETTABLE_CONFIG_KEYS).not.toContain('githubClientId');
    expect(SETTABLE_CONFIG_KEYS).not.toContain('targets');
  });

  it('does not let the renderer set the Docker VM sizes, which config.yaml alone holds', () => {
    expect(SETTABLE_CONFIG_KEYS).not.toContain('dockerVm');
  });

  it('lets the Settings page set what a resource pause does', () => {
    expect(SETTABLE_CONFIG_KEYS).toContain('resourcePause');
  });

  it('has no setting an earlier build had for seatbelt jobs: the job environment, isolation, the tool cache', () => {
    for (const key of ['jobEnvironment', 'isolation', 'toolCacheLocation']) {
      expect(SETTABLE_CONFIG_KEYS).not.toContain(key);
    }
  });
});

describe('DockerVmConfigSource', () => {
  const host = { cores: 8, memoryBytes: 16 * 1024 ** 3 };

  it('reads config.yaml once, and again only when refreshed', () => {
    let reads = 0;
    let section: Record<string, unknown> = { cpus: 2 };
    const source = new DockerVmConfigSource({ read: () => (reads++, section), host, log: () => {} });
    expect(source.current().cpus).toBe(2);
    expect(source.current().cpus).toBe(2);
    expect(reads).toBe(1);
    section = { cpus: 3 };
    expect(source.current().cpus).toBe(2);
    expect(source.refresh().cpus).toBe(3);
    expect(source.current().cpus).toBe(3);
    expect(reads).toBe(2);
  });

  it('logs a clamp once for each value, however often it is read again', () => {
    const logs: string[] = [];
    let section: Record<string, unknown> = { cpus: 100 };
    const source = new DockerVmConfigSource({ read: () => section, host, log: (m) => logs.push(m) });
    for (let i = 0; i < 5; i++) source.refresh();
    expect(logs).toEqual(['dockerVm.cpus 100 is outside 1-64; using 64']);
    section = { cpus: 200 };
    source.refresh();
    source.refresh();
    expect(logs).toEqual(['dockerVm.cpus 100 is outside 1-64; using 64', 'dockerVm.cpus 200 is outside 1-64; using 64']);
  });
});

describe('resolveDockerVmConfig', () => {
  const GiB = 1024 ** 3;
  const host = { cores: 8, memoryBytes: 16 * GiB };

  it('fills every key with its documented default, sized to the host', () => {
    expect(resolveDockerVmConfig(undefined, host)).toEqual({
      prewarm: false,
      cpus: 4,
      memoryMiB: 8192,
      maxRunning: 2,
      dataDiskGiB: 64,
      bootTimeoutSec: 60,
      cacheLimitGiB: 20,
      pullMaxGiB: 10,
      jobPullMaxGiB: 30,
      minFreeGiB: 20,
    });
  });

  it('sizes the defaults down on a small host, never below one VM or one CPU', () => {
    const small = resolveDockerVmConfig({}, { cores: 2, memoryBytes: 7 * GiB });
    expect(small.cpus).toBe(2);
    expect(small.maxRunning).toBe(1);
  });

  it('takes 0 for maxRunning as automatic, and keeps an explicit count', () => {
    expect(resolveDockerVmConfig({ maxRunning: 0 }, host).maxRunning).toBe(2);
    expect(resolveDockerVmConfig({ maxRunning: 3 }, host).maxRunning).toBe(3);
  });

  it('keeps values in range as written', () => {
    const resolved = resolveDockerVmConfig(
      { prewarm: true, cpus: 2, memoryMiB: 4096, dataDiskGiB: 32, bootTimeoutSec: 90, cacheLimitGiB: 5, pullMaxGiB: 2, jobPullMaxGiB: 4, minFreeGiB: 10 },
      host
    );
    expect(resolved).toMatchObject({
      prewarm: true, cpus: 2, memoryMiB: 4096, dataDiskGiB: 32, bootTimeoutSec: 90,
      cacheLimitGiB: 5, pullMaxGiB: 2, jobPullMaxGiB: 4, minFreeGiB: 10,
    });
  });

  it('clamps what is out of range, and says so once per key', () => {
    const logged: string[] = [];
    const resolved = resolveDockerVmConfig(
      { cpus: 999, memoryMiB: 1, maxRunning: -4, dataDiskGiB: 0, bootTimeoutSec: 100000, pullMaxGiB: 50, jobPullMaxGiB: 10 },
      host,
      (message) => logged.push(message)
    );
    expect(resolved.cpus).toBe(64);
    expect(resolved.memoryMiB).toBe(1024);
    expect(resolved.maxRunning).toBe(2);
    expect(resolved.dataDiskGiB).toBe(8);
    expect(resolved.bootTimeoutSec).toBe(600);
    // One job's pulls may fetch no less than one pull may.
    expect(resolved.jobPullMaxGiB).toBe(50);
    for (const key of ['cpus', 'memoryMiB', 'maxRunning', 'dataDiskGiB', 'bootTimeoutSec', 'jobPullMaxGiB']) {
      expect(logged.filter((m) => m.includes(`dockerVm.${key}`))).toHaveLength(1);
    }
  });

  it('takes a value of the wrong type as absent, with a note, and never as a grant', () => {
    const logged: string[] = [];
    const resolved = resolveDockerVmConfig(
      { prewarm: 'yes', cpus: '8', memoryMiB: 4096.5 } as never,
      host,
      (message) => logged.push(message)
    );
    expect(resolved.prewarm).toBe(false);
    expect(resolved.cpus).toBe(4);
    expect(resolved.memoryMiB).toBe(8192);
    expect(logged).toHaveLength(3);
  });

  it('ignores keys it does not know, since no setting enables anything else', () => {
    const resolved = resolveDockerVmConfig({ fallbackDaemon: true } as never, host);
    expect(Object.keys(resolved).sort()).toEqual([
      'bootTimeoutSec', 'cacheLimitGiB', 'cpus', 'dataDiskGiB', 'jobPullMaxGiB',
      'maxRunning', 'memoryMiB', 'minFreeGiB', 'prewarm', 'pullMaxGiB',
    ]);
  });

  it('is read from config.yaml', () => {
    saveConfig({ dockerVm: { cpus: 2, prewarm: true } });
    expect(resolveDockerVmConfig(loadConfig().dockerVm, host)).toMatchObject({ cpus: 2, prewarm: true });
  });
});

describe('resolveResourcePauseConfig', () => {
  it('lets running jobs finish by default', () => {
    expect(resolveResourcePauseConfig(undefined)).toEqual({ runningJobs: 'finish' });
    expect(resolveResourcePauseConfig({})).toEqual({ runningJobs: 'finish' });
  });

  it('keeps either choice as written', () => {
    expect(resolveResourcePauseConfig({ runningJobs: 'stop' }).runningJobs).toBe('stop');
    expect(resolveResourcePauseConfig({ runningJobs: 'finish' }).runningJobs).toBe('finish');
  });

  it('takes anything else as absent, and says so', () => {
    const logged: string[] = [];
    expect(resolveResourcePauseConfig({ runningJobs: 'kill' }, (m) => logged.push(m)).runningJobs).toBe('finish');
    expect(resolveResourcePauseConfig({ runningJobs: true }, (m) => logged.push(m)).runningJobs).toBe('finish');
    expect(logged).toEqual([
      "resourcePause.runningJobs must be 'finish' or 'stop'; using 'finish'",
      "resourcePause.runningJobs must be 'finish' or 'stop'; using 'finish'",
    ]);
  });

  it('is read from config.yaml', () => {
    saveConfig({ resourcePause: { runningJobs: 'stop' } });
    expect(resolveResourcePauseConfig(loadConfig().resourcePause).runningJobs).toBe('stop');
  });
});

describe('a config.yaml an earlier build wrote', () => {
  it('loads with the seatbelt sections it still has, which nothing reads', () => {
    // jobEnvironment, isolation and toolCacheLocation: the store warns about
    // each and drops it at its next save (persist.ts, RETIRED_CONFIG_KEYS).
    fs.writeFileSync(
      configPath,
      [
        'configVersion: 1',
        'theme: dark',
        'jobEnvironment:',
        '  toolShims: false',
        'isolation:',
        '  allowed: [seatbelt, macos-vm]',
        'toolCacheLocation: per-sandbox',
        '',
      ].join('\n')
    );

    const config = loadConfig();

    expect(config.theme).toBe('dark');
  });
});
