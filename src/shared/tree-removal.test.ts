/**
 * Removing a tree its writer sealed.
 *
 * A step or job can take the write bit away from directories it leaves:
 * Go writes its module cache - under GOPATH, which in test mode is in the
 * workspace - as 0555 directories of read-only files. unlink needs write on
 * the directory an entry is in, and moving a directory to another parent
 * needs write on the directory itself, so such a tree can be neither emptied
 * nor taken apart until its write bits are given back.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { moveAsideForRemoval, removeMovedAside } from './tree-removal';

let root: string;
let into: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tree-removal-')));
  into = path.join(root, 'into');
  fs.mkdirSync(into);
});

afterEach(() => {
  jest.restoreAllMocks();
  execChmodWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
});

/** Give every directory under dir its write bit back, so afterEach can remove it. */
function execChmodWritable(dir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;
  fs.chmodSync(dir, 0o700);
  for (const name of fs.readdirSync(dir)) execChmodWritable(path.join(dir, name));
}

/** A tree laid out as Go leaves its module cache: sealed directories of read-only files. */
const sealedTree = (dir: string): void => {
  fs.mkdirSync(path.join(dir, 'pkg', 'mod', 'example.com', 'm@v1.0.0', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pkg', 'mod', 'example.com', 'm@v1.0.0', 'go.mod'), 'module m\n', { mode: 0o444 });
  fs.writeFileSync(path.join(dir, 'pkg', 'mod', 'example.com', 'm@v1.0.0', 'sub', 'x.go'), 'package sub\n', { mode: 0o444 });
  fs.writeFileSync(path.join(dir, 'top'), 'x', { mode: 0o444 });
  for (const sealed of [
    path.join(dir, 'pkg', 'mod', 'example.com', 'm@v1.0.0', 'sub'),
    path.join(dir, 'pkg', 'mod', 'example.com', 'm@v1.0.0'),
    path.join(dir, 'pkg', 'mod', 'example.com'),
    dir,
  ]) {
    fs.chmodSync(sealed, 0o555);
  }
};

describe('removeMovedAside', () => {
  it('removes a tree whose directories, the top one included, were sealed while full', async () => {
    const tree = path.join(into, 'ws-aaaa-1111');
    fs.mkdirSync(tree);
    sealedTree(tree);

    const aside = await moveAsideForRemoval(tree);
    await removeMovedAside(aside!);

    expect(fs.readdirSync(into)).toEqual([]);
  });

  it('never gives the write bit back to what a link swapped in for a sealed directory points to', async () => {
    // A sealed directory's write bit is given back only once moving it up
    // has failed; a writer swaps it for a link to the user's sealed files in
    // between, every time.
    const victim = path.join(root, 'victim');
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, 'keep'), 'kept');
    fs.chmodSync(victim, 0o555);
    const tree = path.join(into, 'ws-aaaa-1111');
    fs.mkdirSync(path.join(tree, 'sealed'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'sealed', 'f'), 'x');
    fs.chmodSync(path.join(tree, 'sealed'), 0o555);
    fs.chmodSync(tree, 0o555);
    const aside = await moveAsideForRemoval(tree);

    const realRename = fs.promises.rename.bind(fs.promises);
    let swapped = false;
    const rename = jest.spyOn(fs.promises, 'rename').mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
      try {
        return await realRename(from, to);
      } catch (err) {
        if (!swapped && path.basename(String(from)) === 'sealed') {
          try {
            // The writer owns it, and can move it once it is writable again.
            fs.chmodSync(String(from), 0o700);
            fs.renameSync(String(from), path.join(root, 'sealed.moved'));
            fs.symlinkSync(victim, String(from));
            swapped = true;
          } catch {
            // The tree is still sealed: nothing to swap into yet.
          }
        }
        throw err;
      }
    }) as never);

    // Refused once it finds the link where the directory was; what is left
    // is only the link, which the next removal unlinks.
    await removeMovedAside(aside!).catch(() => undefined);
    rename.mockRestore();
    await removeMovedAside(aside!).catch(() => undefined);

    expect(swapped).toBe(true);
    expect(fs.statSync(victim).mode & 0o777).toBe(0o555);
    expect(fs.readdirSync(victim)).toEqual(['keep']);
    expect(fs.readdirSync(into)).toEqual([]);
  });
});
