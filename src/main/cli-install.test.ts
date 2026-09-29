/**
 * Installing the CLI runs a shell command as root, through osascript's
 * administrator prompt. The app bundle's path is part of that command, and
 * the user chose where the bundle sits, so the path must reach the shell as
 * data and never as script. No osascript is run here.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

jest.mock('child_process', () => ({
  exec: jest.fn(),
  execFile: jest.fn(),
}));

// What is at /usr/local/bin/localmost is this machine's business; each test
// says what it finds there instead.
jest.mock('fs/promises', () => {
  const actual = jest.requireActual<typeof import('fs/promises')>('fs/promises');
  return { ...actual, lstat: jest.fn(), readlink: jest.fn() };
});

jest.mock('electron', () => ({
  app: { getAppPath: jest.fn(() => '/Applications/localmost.app/Contents/Resources/app.asar') },
  dialog: { showMessageBox: jest.fn(async () => ({ response: 1 })) },
}));

jest.mock('./app-state', () => ({ getMainWindow: jest.fn(() => ({})) }));

import { installCli, uninstallCli } from './cli-install';

const execFile = jest.mocked(childProcess.execFile);
const exec = jest.mocked(childProcess.exec);
const lstat = jest.mocked(fsPromises.lstat);
const readlink = jest.mocked(fsPromises.readlink);

type Callback = (err: Error | null, stdout: string, stderr: string) => void;

const INSTALL_PATH = '/usr/local/bin/localmost';

describe('CLI install and uninstall', () => {
  let scratch: string;
  let resources: string;
  let source: string;
  const savedResourcesPath = process.resourcesPath;

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-install-')));
    // A path that closes a shell quote, substitutes a command and closes an
    // AppleScript string, in that order.
    resources = path.join(scratch, 'a b\'`id`"', 'R');
    fs.mkdirSync(resources, { recursive: true });
    source = path.join(resources, 'localmost-cli');
    fs.writeFileSync(source, '#!/bin/sh\n');
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
    execFile.mockImplementation(((_file: string, _args: string[], callback: Callback) => {
      callback(null, '', '');
    }) as unknown as typeof childProcess.execFile);
    // A command line through a shell, which is what must not be used.
    exec.mockImplementation(((_command: string, callback: Callback) => {
      callback(null, '', '');
    }) as unknown as typeof childProcess.exec);
  });

  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', { value: savedResourcesPath, configurable: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const nothingInstalled = () => {
    lstat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  };

  const linkedTo = (target: string) => {
    lstat.mockResolvedValue({ isSymbolicLink: () => true } as unknown as Awaited<ReturnType<typeof fsPromises.lstat>>);
    readlink.mockResolvedValue(target as never);
  };

  const osascriptCall = () => {
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args] = execFile.mock.calls[0] as unknown as [string, string[]];
    // The script is a run handler given as -e lines; everything after them
    // is argv, data to it.
    const script = args.slice(0, args.lastIndexOf('-e') + 2);
    return { file, script, argv: args.slice(script.length) };
  };

  it('passes the bundle path to the privileged script as an argument, never inside it', async () => {
    nothingInstalled();
    await expect(installCli()).resolves.toEqual({ success: true });

    const { file, script, argv } = osascriptCall();
    expect(file).toBe('/usr/bin/osascript');
    expect(argv).toEqual([source, INSTALL_PATH]);
    expect(script.some((arg) => arg.includes(scratch))).toBe(false);
    expect(script.join('\n')).toContain('quoted form of (item 1 of argv)');
    expect(exec).not.toHaveBeenCalled();
  });

  it('treats a cancelled password prompt as a cancel', async () => {
    nothingInstalled();
    execFile.mockImplementation(((_file: string, _args: string[], callback: Callback) => {
      callback(new Error('Command failed: osascript\nexecution error: User canceled. (-128)'), '', '');
    }) as unknown as typeof childProcess.execFile);
    await expect(installCli()).resolves.toEqual({ success: false, error: 'Installation cancelled' });
  });

  it('removes the link with a fixed script, the path again an argument', async () => {
    linkedTo(source);
    await expect(uninstallCli()).resolves.toEqual({ success: true });

    const { file, script, argv } = osascriptCall();
    expect(file).toBe('/usr/bin/osascript');
    expect(argv).toEqual([INSTALL_PATH]);
    expect(script.some((arg) => arg.includes(INSTALL_PATH))).toBe(false);
    expect(script.join('\n')).toContain('quoted form of (item 1 of argv)');
    expect(exec).not.toHaveBeenCalled();
  });
});
