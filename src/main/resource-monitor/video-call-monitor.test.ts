/**
 * Video call detection as the app runs it: the camera helper found where the
 * app ships it, run, read and ended. A shell script stands in for the helper,
 * printing what the real one prints.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import { CAMERA_HELPER_NAME, cameraHelperPath } from './camera-helper';
import { VideoCallMonitor, type VideoCallState } from './video-call-monitor';

const REPO = path.resolve(__dirname, '..', '..', '..');

const setPackaged = (packaged: boolean) => {
  (app as { isPackaged: boolean }).isPackaged = packaged;
};

const setResourcesPath = (value: string) => {
  Object.defineProperty(process, 'resourcesPath', { value, configurable: true });
};

const waitFor = async (condition: () => boolean, what: string, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('VideoCallMonitor with the camera helper', () => {
  let scratch: string;
  let resources: string;
  let monitor: VideoCallMonitor;
  const savedResourcesPath = process.resourcesPath;

  // Write the stand-in helper into the packaged app's Resources.
  const installHelper = (body: string) => {
    const file = path.join(resources, CAMERA_HELPER_NAME);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
  };

  // What the stand-in helper recorded about how it was run: its pid and args.
  const started = () => path.join(resources, 'started');
  const readStarted = () => {
    const [pid, ...args] = fs.readFileSync(started(), 'utf-8').trim().split(' ');
    return { pid: Number(pid), args };
  };

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'camera-helper-')));
    resources = path.join(scratch, 'localmost.app', 'Contents', 'Resources');
    fs.mkdirSync(resources, { recursive: true });
    setPackaged(true);
    setResourcesPath(resources);
    monitor = new VideoCallMonitor(60);
  });

  afterEach(() => {
    monitor.stop();
    setPackaged(false);
    setResourcesPath(savedResourcesPath);
    jest.restoreAllMocks();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('follows the camera as the helper in Resources reports it, and ends the helper on stop', async () => {
    // Like the real helper: the state at once, then each change, then wait.
    installHelper(
      [
        `echo "$$ $*" > "$(dirname "$0")/started"`,
        'echo false',
        'echo true',
        'echo false',
        'exec sleep 600',
      ].join('\n'),
    );
    const states: VideoCallState[] = [];
    monitor.on('state-changed', (state) => states.push(state));

    monitor.start();
    await waitFor(() => states.length === 2, 'the camera to go on and off');

    expect(states[0]).toMatchObject({ isCameraInUse: true, inGracePeriod: false });
    expect(states[1]).toMatchObject({ isCameraInUse: false, inGracePeriod: true });
    expect(monitor.getPauseReason()).toBe('Video call ended recently');
    const { pid, args } = readStarted();
    expect(args).toEqual(['--watch']);
    expect(isRunning(pid)).toBe(true);

    monitor.stop();
    await waitFor(() => !isRunning(pid), 'the helper to end');
  });

  it('logs once and carries on without detection when the helper is missing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const onChange = jest.fn();
    monitor.on('state-changed', onChange);

    monitor.start();
    await waitFor(() => warn.mock.calls.length > 0, 'the warning');
    // Long enough for a second report, were there one.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('Video call detection unavailable:');
    expect(String(warn.mock.calls[0][1])).toMatch(/ENOENT/);
    expect(onChange).not.toHaveBeenCalled();
    expect(monitor.shouldPause()).toBe(false);
  });

  it('logs once when the helper ends on its own, keeping what it reported', async () => {
    installHelper('echo true\nexit 3');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    monitor.start();
    await waitFor(() => warn.mock.calls.length > 0, 'the warning');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][1])).toMatch(/code 3/);
    expect(monitor.getState().isCameraInUse).toBe(true);
  });
});

describe('where the camera helper is run from', () => {
  const savedResourcesPath = process.resourcesPath;

  afterEach(() => {
    setPackaged(false);
    setResourcesPath(savedResourcesPath);
  });

  it.each([
    '/Applications/localmost.app/Contents/Resources',
    '/Users/someone/Downloads/localmost.app/Contents/Resources',
  ])('is the app’s own Resources when packaged (%s)', (resources) => {
    setPackaged(true);
    setResourcesPath(resources);

    expect(cameraHelperPath()).toBe(path.join(resources, CAMERA_HELPER_NAME));
  });

  it('is the installed is-camera-on package’s helper in development', () => {
    setPackaged(false);

    const helper = cameraHelperPath();
    expect(helper).toBe(path.join(path.dirname(require.resolve('is-camera-on')), CAMERA_HELPER_NAME));
    expect(fs.statSync(helper).mode & 0o111).not.toBe(0);
  });

  it('is not fixed when the main process is bundled', async () => {
    // The bundler rewrites import.meta.url and require.resolve to where the
    // build ran; bundle the monitor as the main process is bundled and check
    // no path of this checkout survives into it.
    const webpack = require('webpack');
    const [mainConfig] = require(path.join(REPO, 'webpack.config.js'));
    const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'camera-bundle-')));
    try {
      const stats = await new Promise<{ hasErrors(): boolean; toString(o: string): string }>((resolve, reject) => {
        webpack(
          {
            ...mainConfig,
            context: REPO,
            mode: 'production',
            devtool: false,
            entry: path.join(__dirname, 'video-call-monitor.ts'),
            output: { path: out, filename: 'main.js', library: { type: 'commonjs2' } },
            plugins: [],
          },
          (err: Error | null, result: { hasErrors(): boolean; toString(o: string): string }) =>
            err ? reject(err) : resolve(result),
        );
      });
      expect(stats.hasErrors() ? stats.toString('errors-only') : '').toBe('');

      const bundle = fs.readFileSync(path.join(out, 'main.js'), 'utf-8');
      const machinePaths = [REPO, fs.realpathSync(path.join(REPO, 'node_modules'))];
      const found = (bundle.match(/file:\/\/[^"'`]*|\/[^"'`\s]*/g) ?? []).filter(
        (text) => text.startsWith('file://') || machinePaths.some((dir) => text.includes(dir)),
      );
      expect(found).toEqual([]);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
