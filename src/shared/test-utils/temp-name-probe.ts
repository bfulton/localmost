/**
 * Probes of what a sandbox profile lets a process make in the per-user temp
 * directory by a generated name, for the *.sandbox.test.ts files.
 *
 * The per-user temp is the user's own, shared with every process they run,
 * and names of the shapes probed here are ones their own tools make there:
 * SwiftPM and swift-driver keep a manifest they are about to run, its object
 * file and their response files in `T/TemporaryDirectory.XXXXXX`. So a probe
 * takes only a name nothing has, and removes only what its own mkdir made:
 * never recursively, never a name already there, never after a mkdir that
 * failed, whatever appeared at the path meanwhile.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** `count` random characters of the alphabet mkdtemp fills a template's X's from. */
export function mkdtempChars(count: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return [...crypto.randomBytes(count)].map((byte) => alphabet[byte % alphabet.length]).join('');
}

/** The names a probe may make, and so remove: one entry, `Temporary<Word>[.]<chars>`. */
const PROBE_NAME = /^Temporary[A-Za-z]+\.?[A-Za-z0-9_-]*$/;

/** A word for a shell command line, quoted so nothing in it is special. */
const sq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** The file a probe puts inside the directory it made, standing in for a link's response file. */
const PROBE_FILE = 'link.resp';

/**
 * Whether `run` - a shell command run under the profile being probed - can
 * make the directory `name` in the per-user temp `userTemp` with mkdir (never
 * -p) and then a file inside it. Throws, touching nothing, if anything is at
 * that path already. Afterwards removes the file and the directory if, and
 * only if, its own mkdir made the directory; one that is not empty then
 * stays, and the probe throws.
 */
export function probeTempDirName(run: (command: string) => boolean, userTemp: string, name: string): boolean {
  if (!PROBE_NAME.test(name)) throw new Error(`${JSON.stringify(name)} is not a probe name`);
  const temp = path.resolve(userTemp);
  const dir = path.join(temp, name);
  if (path.dirname(dir) !== temp) throw new Error(`${JSON.stringify(name)} is not a probe name`);
  const there = (p: string) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  if (there(dir)) throw new Error(`${dir} already exists`);
  const made = run(`/bin/mkdir ${sq(dir)}`);
  if (!made) return false;
  try {
    return run(`/usr/bin/touch ${sq(path.join(dir, PROBE_FILE))}`);
  } finally {
    fs.rmSync(path.join(dir, PROBE_FILE), { force: true });
    fs.rmdirSync(dir);
  }
}
