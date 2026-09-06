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

import { saveConfig, loadConfig } from './config';

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
