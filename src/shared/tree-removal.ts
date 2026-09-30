/**
 * Removing a directory tree something untrusted may still be writing.
 *
 * Used for a runner job's sandbox (src/main/runner-cleanup.ts) and for a
 * `localmost test` workspace (workspace.ts). Kept free of electron so both
 * the app and the CLI can use it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

/** The start of the name a tree is moved to before it is removed. */
export const REMOVAL_PREFIX = '.removing-';

/**
 * Move a directory a job or step could write beside itself, under a name no
 * profile grants, so that it can be removed (see removeMovedAside). A process
 * the job left running - one that left its process group with setsid() and
 * outlived the sweep by profile mark - still writes the directory's path.
 * seatbelt checks a write against the path the file has at the time of the
 * write, so once moved nothing in the tree is writable to such a process,
 * whatever it holds open there, its working directory included. The
 * directory it sits in must be one no profile grants either. Resolves to
 * where it went, or null when it was already gone; rejects, leaving it where
 * it is, when it cannot be moved.
 */
export async function moveAsideForRemoval(dir: string): Promise<string | null> {
  const aside = path.join(
    path.dirname(dir),
    `${REMOVAL_PREFIX}${path.basename(dir)}.${randomBytes(4).toString('hex')}`
  );
  try {
    await fs.promises.rename(dir, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return aside;
}

/** How many times a directory is listed when something keeps adding to it. */
const REMOVAL_PASSES = 3;
/** How many directories, and how many entries of each, are removed at once. */
const REMOVAL_BATCH = 32;

/**
 * Remove a tree moveAsideForRemoval moved aside, without following a link
 * anywhere in it - even one swapped in while this walks it.
 *
 * Moving the tree aside stops only the writers seatbelt confines. A container
 * a job or step started writes the workspace it bind-mounts through its
 * Docker VM's virtiofs share, whose server is not under the job's profile,
 * and may keep writing the tree wherever it is. A walk by path, as fs.rm's is, loses to such a writer: it
 * finds a directory, the writer swaps it for a link, and the walk goes
 * through the link and deletes what it points to. So this never uses a path
 * more than one level below the directory the tree was moved into, which
 * only the app writes. Each directory it lists is an entry there that lstat
 * found a directory, and each entry in it is unlinked, or, when it is a
 * directory, removed if empty or else moved up there to be listed in turn.
 * None of unlink, rmdir and rename follows a link at the path it is given.
 * A directory its owner sealed - took write away from - is given it back:
 * one listed there by path, as nothing can swap it, and one in the tree only
 * through a descriptor opened without following a link. Rejects, leaving
 * the rest for the next sweep, when something cannot be removed or keeps
 * being added.
 */
export async function removeMovedAside(aside: string): Promise<void> {
  const into = path.dirname(aside);
  const stem = path.join(into, `${REMOVAL_PREFIX}${randomBytes(6).toString('hex')}`);
  const code = (err: unknown) => (err as NodeJS.ErrnoException).code;
  let moved = 0;
  // Give a directory in the tree its owner's permissions back, when it is
  // still a directory: resolves to whether it did.
  const unseal = async (dir: string): Promise<boolean> => {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(
        dir,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
      );
    } catch {
      return false;
    }
    try {
      await handle.chmod(0o700);
      return true;
    } catch {
      return false;
    } finally {
      await handle.close();
    }
  };
  // Clear one entry of a directory being listed: unlinked, or, when it is a
  // directory - which the listing only suggests, as it may since have been
  // swapped - moved up beside the tree and returned, to be listed in turn.
  const clear = async (entry: fs.Dirent, dir: string): Promise<string | null> => {
    const from = path.join(dir, entry.name);
    if (!entry.isDirectory()) {
      try {
        await fs.promises.unlink(from);
        return null;
      } catch (err) {
        if (code(err) === 'ENOENT') return null;
        // unlink refuses a directory with EPERM on macOS
        if (code(err) !== 'EPERM' && code(err) !== 'EISDIR') throw err;
      }
    }
    const up = `${stem}.${++moved}`;
    try {
      await fs.promises.rename(from, up);
      return up;
    } catch (err) {
      if (code(err) === 'ENOENT') return null;
      // A directory its owner cannot write - as Go leaves its module cache -
      // cannot be moved to another parent, which rewrites its `..`. Its
      // write bit is given back through a descriptor opened without
      // following a link, so a link swapped in for it is refused.
      if (code(err) === 'EACCES' && (await unseal(from))) {
        try {
          await fs.promises.rename(from, up);
          return up;
        } catch (again) {
          if (code(again) === 'ENOENT') return null;
        }
      }
      // An empty directory that cannot be moved - one its owner cannot
      // write, nor read to give the write bit back - can still be removed
      // where it is.
      await fs.promises.rmdir(from).catch(() => {
        throw err;
      });
      return null;
    }
  };
  // Remove one entry beside the tree - the tree itself, or a directory moved
  // up from it - returning the directories it moved up in turn.
  const remove = async (dir: string): Promise<string[]> => {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(dir);
    } catch (err) {
      if (code(err) === 'ENOENT') return [];
      throw err;
    }
    if (!stat.isDirectory()) {
      await fs.promises.unlink(dir).catch((err) => {
        if (code(err) !== 'ENOENT') throw err;
      });
      return [];
    }
    // Its entries can only be removed while it is writable, and listed while
    // it is readable. It is an entry of the directory the tree was moved
    // into, which only the app writes, so it is still the directory lstat
    // found, and chmod cannot be led through a link.
    if ((stat.mode & 0o700) !== 0o700) {
      await fs.promises.chmod(dir, 0o700);
    }
    const found: string[] = [];
    for (let pass = 1; ; pass++) {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (let i = 0; i < entries.length; i += REMOVAL_BATCH) {
        const batch = entries.slice(i, i + REMOVAL_BATCH);
        for (const up of await Promise.all(batch.map((entry) => clear(entry, dir)))) {
          if (up) found.push(up);
        }
      }
      try {
        await fs.promises.rmdir(dir);
        return found;
      } catch (err) {
        if (code(err) === 'ENOENT') return found;
        if (code(err) !== 'ENOTEMPTY' || pass >= REMOVAL_PASSES) throw err;
      }
    }
  };
  const pending = [aside];
  while (pending.length > 0) {
    const round = pending.splice(0, REMOVAL_BATCH);
    for (const found of await Promise.all(round.map(remove))) pending.push(...found);
  }
}
