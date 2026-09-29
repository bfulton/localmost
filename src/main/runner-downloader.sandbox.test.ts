import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RunnerDownloader } from './runner-downloader';

/**
 * buildSandbox and copyProxyCredentials against a real directory tree: what a
 * worker's sandbox, which its job can read, ends up holding.
 */
describe('the sandbox a worker is built from', () => {
  const version = '9.9.9';
  let root: string;
  let runnerDir: string;
  let downloader: RunnerDownloader;
  const savedConfigDir = process.env.LOCALMOST_CONFIG_DIR;

  const write = (file: string, content: string, mode = 0o644) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode });
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sandbox-'));
    process.env.LOCALMOST_CONFIG_DIR = root;
    runnerDir = path.join(root, 'runner');
    const arc = path.join(runnerDir, 'arc', `v${version}`);
    write(path.join(arc, 'run.sh'), '#!/bin/bash\n', 0o755);
    write(path.join(arc, 'config.sh'), '#!/bin/bash\n', 0o755);
    write(path.join(arc, 'bin', 'Runner.Listener'), 'listener', 0o755);

    // What registration leaves under proxies/<target>/<n>: the registration's
    // own key, which only the app may hold.
    const proxy = path.join(runnerDir, 'proxies', 'target-a', '1');
    write(path.join(proxy, '.runner'), JSON.stringify({
      agentName: 'localmost.x.1',
      serverUrl: 'https://pipelines.actions.githubusercontent.com/abc/',
      serverUrlV2: 'https://broker.actions.githubusercontent.com/',
    }));
    write(path.join(proxy, '.credentials'), JSON.stringify({
      scheme: 'OAuth',
      data: { clientId: 'registration-client', authorizationUrl: 'https://tokenghub.actions.githubusercontent.com/_apis/oauth2/token/x', requireFipsCryptography: 'True' },
    }));
    write(path.join(proxy, '.credentials_rsaparams'), JSON.stringify({ d: 'REGISTRATION-PRIVATE-KEY' }));

    downloader = new RunnerDownloader();
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
    else process.env.LOCALMOST_CONFIG_DIR = savedConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("never carries the registration's key or credentials into the sandbox", async () => {
    await downloader.copyProxyCredentials(1, path.join(runnerDir, 'proxies', 'target-a'));
    const sandbox = await downloader.buildSandbox(1, version);

    expect(fs.existsSync(path.join(sandbox, '.runner'))).toBe(true);
    expect(fs.existsSync(path.join(sandbox, '.credentials_rsaparams'))).toBe(false);
    expect(fs.existsSync(path.join(sandbox, '.credentials'))).toBe(false);
    // Nor a second copy app-side: nothing reads the key from the config dir.
    expect(fs.existsSync(path.join(runnerDir, 'config', '1', '.credentials_rsaparams'))).toBe(false);
    const everything = fs.readdirSync(sandbox, { recursive: true }).map(String);
    for (const file of everything) {
      const full = path.join(sandbox, file);
      if (fs.statSync(full).isFile()) {
        expect(fs.readFileSync(full, 'utf-8')).not.toContain('REGISTRATION-PRIVATE-KEY');
      }
    }
  });

  it('drops a key an earlier version left in the config dir, and never copies one from there', async () => {
    // Earlier versions copied all three files into config/<n>, and a legacy
    // registration saved its own there.
    write(path.join(runnerDir, 'config', '1', '.credentials_rsaparams'), JSON.stringify({ d: 'REGISTRATION-PRIVATE-KEY' }));
    write(path.join(runnerDir, 'config', '1', '.credentials'), '{}');

    const sandboxWithLegacy = await downloader.buildSandbox(1, version);
    expect(fs.existsSync(path.join(sandboxWithLegacy, '.credentials_rsaparams'))).toBe(false);
    expect(fs.existsSync(path.join(sandboxWithLegacy, '.credentials'))).toBe(false);

    await downloader.copyProxyCredentials(1, path.join(runnerDir, 'proxies', 'target-a'));
    expect(fs.existsSync(path.join(runnerDir, 'config', '1', '.credentials_rsaparams'))).toBe(false);
    expect(fs.existsSync(path.join(runnerDir, 'config', '1', '.credentials'))).toBe(false);
  });

  it('still requires the registration to be complete before a worker is built from it', async () => {
    fs.rmSync(path.join(runnerDir, 'proxies', 'target-a', '1', '.credentials_rsaparams'));
    await expect(downloader.copyProxyCredentials(1, path.join(runnerDir, 'proxies', 'target-a')))
      .rejects.toThrow('Missing proxy credential file');
  });
});
