/**
 * Camera helper - runs the is-camera-on helper binary and reports what it
 * sees.
 *
 * The helper is a small Swift program from the is-camera-on package. With
 * --watch it prints the camera state straight away and again on each change,
 * one "true" or "false" per line. It reads CoreMediaIO's is-running-somewhere
 * property of each camera; it never opens a camera, so it needs no camera
 * permission.
 *
 * The package's own JavaScript finds the helper next to itself through
 * import.meta.url, which the bundler fixes to the build machine's
 * node_modules. The helper therefore ships in the app's Resources, signed with
 * the app, and is run from there.
 */

import { spawn } from 'child_process';
import { app } from 'electron';
import { createRequire } from 'module';
import * as path from 'path';
import * as readline from 'readline';

/** Name of the helper, in the package and in the app's Resources. */
export const CAMERA_HELPER_NAME = 'is-camera-on';

/**
 * Where the helper is: the app's Resources when packaged, else the
 * is-camera-on package this checkout installed, found when asked rather than
 * when built.
 */
export function cameraHelperPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, CAMERA_HELPER_NAME);
  }
  const packageMain = createRequire(__filename).resolve('is-camera-on');
  return path.join(path.dirname(packageMain), CAMERA_HELPER_NAME);
}

export interface CameraWatch {
  /** Stop watching and end the helper. */
  stop(): void;
}

/**
 * Run the helper at helperPath with --watch, calling onChange with each state
 * it prints. If the helper cannot run or ends on its own, onUnavailable is
 * called once and nothing more is reported.
 */
export function watchCamera(
  helperPath: string,
  onChange: (isOn: boolean) => void,
  onUnavailable: (error: Error) => void
): CameraWatch {
  let ended = false;
  const child = spawn(helperPath, ['--watch'], { stdio: ['ignore', 'pipe', 'ignore'] });

  const fail = (error: Error) => {
    if (ended) return;
    ended = true;
    onUnavailable(error);
  };
  child.on('error', fail);
  // 'close' comes after stdout has been read to the end, so every line the
  // helper printed has been reported by then.
  child.on('close', (code, signal) => {
    fail(new Error(`${CAMERA_HELPER_NAME} exited (${signal ?? `code ${code}`})`));
  });

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!ended) onChange(line.trim() === 'true');
  });

  return {
    stop() {
      if (ended) return;
      ended = true;
      child.kill();
    },
  };
}
