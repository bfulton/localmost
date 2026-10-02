/**
 * Resolving a path a workflow names without letting it leave where it belongs.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolve `target` against `root`, and refuse it unless it is inside `root`.
 *
 * A step's working-directory, a local action's path and an action's subpath
 * and entry point are the workflow's to choose. Resolved as written, "/" or
 * "../.." or a symlink in the checkout would put the step outside the
 * directory it was given. Compared as real paths, so a symlink is judged by
 * where it leads; returns the real path.
 */
export function resolveWithin(root: string, target: string, what: string, rootName = 'the workspace'): string {
  const realRoot = fs.realpathSync(root);
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(realRoot, target));
  } catch {
    throw new Error(`${what} does not exist: ${target}`);
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new Error(`${what} is outside ${rootName}: ${target}`);
  }
  return real;
}
