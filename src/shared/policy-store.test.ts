import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  approvalStamp,
  approveConfig,
  approvePending,
  bindRepositoryId,
  isValidRepository,
  listPolicyEntries,
  policyFilePath,
  readPolicyEntry,
  recordPending,
  recordPolicyDecision,
  rejectPending,
} from './policy-store';
import { LocalmostrcConfig } from './localmostrc';

const REPO = 'owner/repo';
const NARROW: LocalmostrcConfig = { version: 1, shared: { network: { allow: ['index.crates.io'] } } };
const WIDE: LocalmostrcConfig = { version: 1, level: 'permissive' };

let dir: string;
beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'policy-store-')), 'policies');
});
afterEach(() => {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

const writeRaw = (repository: string, raw: unknown) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(policyFilePath(dir, repository), JSON.stringify(raw));
};

describe('repository names', () => {
  it('accepts what GitHub accepts, dots and underscores included', () => {
    for (const name of ['owner/repo', 'my-org/my.repo', 'a/b_c', 'O-1/.github', 'x/repo.js']) {
      expect(isValidRepository(name)).toBe(true);
    }
  });

  it('refuses anything that could leave the cache directory or alias another name', () => {
    // The renderer and the CLI hand this module a name; the file it maps to is
    // written. Only the first "/" used to be replaced, and ".." was not refused.
    for (const name of ['a/../../../escaped', '../x', 'a/b/c', 'a/..', 'a/.', '/abs', 'a/', '/b', 'a%5Fb/c', '_a/b', 'a/b\\c', 'a/b\n', '']) {
      expect(isValidRepository(name)).toBe(false);
      expect(() => policyFilePath(dir, name)).toThrow(/repository/);
    }
  });

  it('accepts an Enterprise Managed User as owner, and keeps its entry apart', () => {
    // EMU handles are "<user>_<shortcode>", and such a user can own the
    // repository a runner serves. Refusing "_" in the owner refused every job
    // from it that carried a .localmostrc, as "could not verify".
    const emu = 'octocat_acme/repo';
    const lookalike = 'octocat/acme_repo';
    expect(isValidRepository(emu)).toBe(true);
    expect(policyFilePath(dir, emu)).not.toBe(policyFilePath(dir, lookalike));

    recordPending(dir, emu, NARROW);
    recordPending(dir, lookalike, WIDE);
    expect(readPolicyEntry(dir, emu)?.pending?.config).toEqual(NARROW);
    expect(readPolicyEntry(dir, lookalike)?.pending?.config).toEqual(WIDE);
    expect(listPolicyEntries(dir).map((e) => e.repository).sort()).toEqual([lookalike, emu]);
  });

  it('keeps the file name of every owner without "_", so existing entries still read', () => {
    expect(policyFilePath(dir, 'my-org/my_repo.js')).toBe(path.join(dir, 'my-org_my_repo.js.json'));
  });

  it('keeps every write inside the cache directory', () => {
    expect(() => recordPending(dir, 'a/../../../escaped', NARROW)).toThrow();
    expect(fs.existsSync(path.join(dir, '..', 'escaped.json'))).toBe(false);
    expect(path.dirname(policyFilePath(dir, 'my-org/my.repo'))).toBe(dir);
  });
});

describe('a pending policy is kept apart from the approved one', () => {
  it('leaves the approved policy in force when another is recorded as pending', () => {
    // A refused job's policy used to overwrite the cache entry, approved or
    // not, so the approved policy stopped applying and whatever the next job
    // asked for was what the next click approved.
    recordPending(dir, REPO, NARROW);
    approvePending(dir, REPO, approvalStamp(REPO, NARROW));

    recordPending(dir, REPO, WIDE);

    const entry = readPolicyEntry(dir, REPO)!;
    expect(entry.approved?.config).toEqual(NARROW);
    expect(entry.pending?.config).toEqual(WIDE);
  });

  it('approves only the policy whose stamp was quoted', () => {
    recordPending(dir, REPO, NARROW);
    const shown = approvalStamp(REPO, NARROW);
    // Another job arrives between the reviewer reading the card and clicking.
    recordPending(dir, REPO, WIDE);

    expect(() => approvePending(dir, REPO, shown)).toThrow(/changed since/);
    expect(readPolicyEntry(dir, REPO)!.approved).toBeUndefined();

    approvePending(dir, REPO, approvalStamp(REPO, WIDE));
    const entry = readPolicyEntry(dir, REPO)!;
    expect(entry.approved?.config).toEqual(WIDE);
    expect(entry.pending).toBeUndefined();
  });

  it('refuses to approve when nothing is pending', () => {
    expect(() => approvePending(dir, REPO, approvalStamp(REPO, NARROW))).toThrow(/nothing/i);
  });

  it('rejecting drops only the pending policy', () => {
    recordPending(dir, REPO, NARROW);
    approvePending(dir, REPO, approvalStamp(REPO, NARROW));
    recordPending(dir, REPO, WIDE);

    expect(rejectPending(dir, REPO)).toBe(approvalStamp(REPO, WIDE));
    const entry = readPolicyEntry(dir, REPO)!;
    expect(entry.approved?.config).toEqual(NARROW);
    expect(entry.pending).toBeUndefined();
  });

  it('keeps the repository id with each policy, and approving carries it over', () => {
    recordPending(dir, REPO, NARROW, 41);
    expect(readPolicyEntry(dir, REPO)!.pending?.repositoryId).toBe(41);
    approvePending(dir, REPO, approvalStamp(REPO, NARROW, 41));
    expect(readPolicyEntry(dir, REPO)!.approved?.repositoryId).toBe(41);

    // A pending policy that names no id leaves the approved one's in place.
    recordPending(dir, REPO, WIDE);
    approvePending(dir, REPO, approvalStamp(REPO, WIDE));
    expect(readPolicyEntry(dir, REPO)!.approved?.repositoryId).toBe(41);
  });

  it('approving a config directly keeps the id the approval is bound to', () => {
    recordPending(dir, REPO, NARROW, 41);
    approvePending(dir, REPO, approvalStamp(REPO, NARROW, 41));
    approveConfig(dir, REPO, WIDE);
    expect(readPolicyEntry(dir, REPO)!.approved?.repositoryId).toBe(41);
  });

  it('approving a config directly never moves the approval to another repository', () => {
    // The CLI shows the operator's clone, which carries no id, so a pending
    // policy identical to it from a repository that took the name would be
    // approved for that repository without its id ever being shown.
    recordPending(dir, REPO, NARROW, 1);
    approvePending(dir, REPO, approvalStamp(REPO, NARROW, 1));
    recordPending(dir, REPO, NARROW, 2);

    approveConfig(dir, REPO, NARROW);
    const entry = readPolicyEntry(dir, REPO)!;
    expect(entry.approved?.repositoryId).toBe(1);
    // Still waiting, for the app's card, which shows the id changing.
    expect(entry.pending?.repositoryId).toBe(2);
  });

  it('approving a config directly takes the pending id only when the approval has none', () => {
    recordPending(dir, REPO, NARROW, 42);
    approveConfig(dir, REPO, NARROW);
    const entry = readPolicyEntry(dir, REPO)!;
    expect(entry.approved?.repositoryId).toBe(42);
    expect(entry.pending).toBeUndefined();
  });

  it('refuses an approval when the repository behind the pending policy changed since it was shown', () => {
    recordPending(dir, REPO, NARROW, 1);
    approvePending(dir, REPO, approvalStamp(REPO, NARROW, 1));
    recordPending(dir, REPO, NARROW, 2);
    const shown = approvalStamp(REPO, NARROW, 2);
    // The same file, from yet another repository under the name.
    recordPending(dir, REPO, NARROW, 3);

    expect(() => approvePending(dir, REPO, shown)).toThrow(/changed since/);
    expect(readPolicyEntry(dir, REPO)!.approved?.repositoryId).toBe(1);
  });

  it('stores no repository id that is not one, and keeps the entry readable', () => {
    recordPending(dir, REPO, NARROW, 5);
    approvePending(dir, REPO, approvalStamp(REPO, NARROW, 5));
    for (const bad of [NaN, 0, -3, 1.5, Infinity]) {
      recordPending(dir, REPO, WIDE, bad);
      const entry = readPolicyEntry(dir, REPO)!;
      expect(entry.pending?.config).toEqual(WIDE);
      expect(entry.pending?.repositoryId).toBeUndefined();
      expect(entry.approved?.repositoryId).toBe(5);
    }
  });

  it('binds an approved policy to a repository id only while it has none', () => {
    recordPending(dir, REPO, NARROW);
    approvePending(dir, REPO, approvalStamp(REPO, NARROW));

    bindRepositoryId(dir, REPO, 7);
    expect(readPolicyEntry(dir, REPO)!.approved?.repositoryId).toBe(7);
    bindRepositoryId(dir, REPO, 8);
    expect(readPolicyEntry(dir, REPO)!.approved?.repositoryId).toBe(7);
  });

  it('binds no repository id that is not one', () => {
    recordPending(dir, REPO, NARROW);
    approvePending(dir, REPO, approvalStamp(REPO, NARROW));
    bindRepositoryId(dir, REPO, NaN);
    bindRepositoryId(dir, REPO, 0);
    expect(readPolicyEntry(dir, REPO)!.approved?.config).toEqual(NARROW);
    expect(readPolicyEntry(dir, REPO)!.approved?.repositoryId).toBeUndefined();
  });

  it('distrusts an entry whose repository id is not one', () => {
    for (const repositoryId of ['7', 0, -1, 1.5, null]) {
      writeRaw(REPO, { format: 2, repository: REPO, approved: { config: NARROW, at: '', repositoryId } });
      expect(() => readPolicyEntry(dir, REPO)).toThrow(/repositoryId/);
    }
  });

  it('approving a config directly clears a pending entry only when it is the same policy', () => {
    recordPending(dir, REPO, WIDE);
    approveConfig(dir, REPO, NARROW);
    expect(readPolicyEntry(dir, REPO)!.pending?.config).toEqual(WIDE);

    approveConfig(dir, REPO, WIDE);
    expect(readPolicyEntry(dir, REPO)!.pending).toBeUndefined();
  });
});

describe('the stamp', () => {
  it('changes with anything in the policy, the level included', () => {
    expect(approvalStamp(REPO, NARROW)).not.toBe(approvalStamp(REPO, { ...NARROW, level: 'moderate' }));
    expect(approvalStamp(REPO, NARROW)).not.toBe(approvalStamp('owner/other', NARROW));
    expect(approvalStamp(REPO, NARROW)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('covers the repository id when there is one, and is unchanged when there is none', () => {
    expect(approvalStamp(REPO, NARROW, 1)).not.toBe(approvalStamp(REPO, NARROW, 2));
    expect(approvalStamp(REPO, NARROW, 1)).not.toBe(approvalStamp(REPO, NARROW));
    expect(approvalStamp(REPO, NARROW, undefined)).toBe(approvalStamp(REPO, NARROW));
  });

  it('does not depend on key order, so the same policy read back matches', () => {
    const reordered = { shared: { network: { allow: ['index.crates.io'] } }, version: 1 } as LocalmostrcConfig;
    expect(approvalStamp(REPO, reordered)).toBe(approvalStamp(REPO, NARROW));
  });
});

describe('reading the cache', () => {
  it('reads the format written before pending and approved were separate', () => {
    writeRaw(REPO, { repository: REPO, config: NARROW, cachedAt: '2026-01-01T00:00:00Z', approved: true });
    expect(readPolicyEntry(dir, REPO)).toEqual({
      repository: REPO,
      approved: { config: NARROW, at: '2026-01-01T00:00:00Z' },
    });

    writeRaw(REPO, { repository: REPO, config: WIDE, cachedAt: '2026-01-02T00:00:00Z', approved: false });
    expect(readPolicyEntry(dir, REPO)).toEqual({
      repository: REPO,
      pending: { config: WIDE, at: '2026-01-02T00:00:00Z' },
    });
  });

  it('rewrites an old entry in the new format when it next changes', () => {
    writeRaw(REPO, { repository: REPO, config: NARROW, cachedAt: '2026-01-01T00:00:00Z', approved: true });
    recordPending(dir, REPO, WIDE);
    const raw = JSON.parse(fs.readFileSync(policyFilePath(dir, REPO), 'utf-8'));
    expect(raw.format).toBe(2);
    expect(raw.approved.config).toEqual(NARROW);
    expect(raw.pending.config).toEqual(WIDE);
  });

  it('holds a cached policy to the same grammar as the file it came from', () => {
    // The cache is JSON the app wrote, but nothing stopped anything else from
    // writing it; a config that would not parse as a .localmostrc is not one.
    writeRaw(REPO, { format: 2, repository: REPO, approved: { config: { version: 1, level: 'yolo' }, at: '' } });
    expect(() => readPolicyEntry(dir, REPO)).toThrow(/level/);

    writeRaw(REPO, { format: 2, repository: REPO, approved: { config: { version: 1, shared: { sockets: {} } }, at: '' } });
    expect(() => readPolicyEntry(dir, REPO)).toThrow();

    writeRaw(REPO, { format: 2, repository: REPO, approved: 'yes' });
    expect(() => readPolicyEntry(dir, REPO)).toThrow();

    writeRaw(REPO, { repository: REPO, config: NARROW, approved: 'true' });
    expect(() => readPolicyEntry(dir, REPO)).toThrow();
  });

  it('refuses an entry that names a different repository from its file', () => {
    writeRaw(REPO, { format: 2, repository: 'someone/else', approved: { config: WIDE, at: '' } });
    expect(() => readPolicyEntry(dir, REPO)).toThrow(/repository/);
  });

  describe('an entry that no longer reads is replaced, not a lockout', () => {
    // The grammar has tightened since entries were first written, and the
    // writer before this one was not atomic. An entry that fails today's
    // checks made every writer throw, so a refused job recorded nothing, the
    // app had nothing to show, and the CLI could not approve over it either:
    // the repository stayed refused until someone deleted the file by hand.
    const unreadable: Array<[string, () => void]> = [
      ['an old entry the grammar no longer accepts', () =>
        writeRaw(REPO, { repository: REPO, config: { version: 1, shared: { sockets: {} } }, cachedAt: '', approved: true })],
      ['a truncated entry', () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(policyFilePath(dir, REPO), '{"format": 2, "repository": "owner/re');
      }],
      ['an entry for another repository', () =>
        writeRaw(REPO, { format: 2, repository: 'someone/else', approved: { config: WIDE, at: '' } })],
    ];

    for (const [what, write] of unreadable) {
      it(`records a pending policy over ${what}, which can then be approved`, () => {
        write();
        recordPending(dir, REPO, NARROW);

        // Nothing of the old entry survives: its approved slot was never
        // trustworthy, so dropping it grants nothing.
        const raw = JSON.parse(fs.readFileSync(policyFilePath(dir, REPO), 'utf-8'));
        expect(raw).toEqual({ format: 2, repository: REPO, pending: { config: NARROW, at: expect.any(String) } });
        expect(listPolicyEntries(dir).map((e) => e.repository)).toEqual([REPO]);

        approvePending(dir, REPO, approvalStamp(REPO, NARROW));
        expect(readPolicyEntry(dir, REPO)?.approved?.config).toEqual(NARROW);
      });

      it(`approves a policy directly over ${what}`, () => {
        write();
        approveConfig(dir, REPO, NARROW);
        expect(readPolicyEntry(dir, REPO)).toEqual({ repository: REPO, approved: { config: NARROW, at: expect.any(String) } });
      });

      it(`has nothing pending to reject in ${what}`, () => {
        write();
        expect(rejectPending(dir, REPO)).toBeUndefined();
      });
    }
  });

  it('matches the repository without regard to case, as GitHub does', () => {
    recordPending(dir, 'Owner/Repo', NARROW);
    expect(readPolicyEntry(dir, 'owner/repo')?.pending?.config).toEqual(NARROW);
  });

  it('keeps one file per repository whatever casing names it, on any volume', () => {
    // The target's name and the name GitHub reports can differ in case. On a
    // case-sensitive volume they used to be two files, so an approval
    // recorded under one was not found under the other.
    expect(policyFilePath(dir, 'Owner/Repo')).toBe(policyFilePath(dir, 'owner/repo'));
    expect(policyFilePath(dir, 'Octo_Cat/Repo')).toBe(policyFilePath(dir, 'octo_cat/repo'));
  });

  it('still reads, and folds in, an entry written under a mixed-case file name', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'Owner_Repo.json'),
      JSON.stringify({ format: 2, repository: 'Owner/Repo', approved: { config: NARROW, at: '' } })
    );
    expect(readPolicyEntry(dir, 'owner/repo')?.approved?.config).toEqual(NARROW);

    // Changing it must neither lose the approved slot nor leave two files -
    // and on a volume that ignores case, the old name is the new file.
    recordPending(dir, 'owner/repo', WIDE);
    const entries = listPolicyEntries(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].approved?.config).toEqual(NARROW);
    expect(entries[0].pending?.config).toEqual(WIDE);
    expect(readPolicyEntry(dir, 'OWNER/REPO')?.approved?.config).toEqual(NARROW);
  });

  describe('on a volume that does not find the old casing by the lowercased name', () => {
    // This Mac's volume ignores case, so the lowercased name is made to miss
    // here, as it does on a case-sensitive volume, to reach the scan.
    // The module object itself: the namespace import is read-only.
    const nodeFs = jest.requireActual<typeof fs>('fs');
    let existsSpy: jest.SpiedFunction<typeof fs.existsSync>;
    beforeEach(() => {
      const realExists = nodeFs.existsSync.bind(nodeFs);
      existsSpy = jest.spyOn(nodeFs, 'existsSync').mockImplementation(
        (p) => String(p) !== policyFilePath(dir, REPO) && realExists(p)
      );
    });
    afterEach(() => existsSpy.mockRestore());

    it('finds the entry by scanning, and removes the file it read only when that is another file', () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'Owner_Repo.json'),
        JSON.stringify({ format: 2, repository: 'Owner/Repo', approved: { config: NARROW, at: '' } })
      );
      expect(readPolicyEntry(dir, REPO)?.approved?.config).toEqual(NARROW);

      // Written under the lowercased name, which here is the same file as
      // the one read: removing the old name would delete what was written.
      recordPending(dir, REPO, WIDE);
      existsSpy.mockRestore();
      const entry = readPolicyEntry(dir, REPO);
      expect(entry?.approved?.config).toEqual(NARROW);
      expect(entry?.pending?.config).toEqual(WIDE);
    });
  });

  it('lists valid entries and skips the rest', () => {
    recordPending(dir, REPO, NARROW);
    recordPending(dir, 'my-org/my.repo', WIDE);
    fs.writeFileSync(path.join(dir, 'broken_entry.json'), '{ not json');
    fs.writeFileSync(path.join(dir, 'liar_repo.json'), JSON.stringify({ format: 2, repository: REPO, pending: { config: WIDE, at: '' } }));

    expect(listPolicyEntries(dir).map((e) => e.repository).sort()).toEqual(['my-org/my.repo', REPO]);
  });

  it('writes entries readable only by the owner', () => {
    recordPending(dir, REPO, NARROW);
    expect(fs.statSync(policyFilePath(dir, REPO)).mode & 0o077).toBe(0);
  });
});

describe('the decision log', () => {
  it('records the stamp of what was decided, and through what', () => {
    recordPolicyDecision(dir, { repository: REPO, decision: 'approved', stamp: 'abc', via: 'cli' });
    const [line] = fs.readFileSync(path.join(dir, 'decisions.log'), 'utf-8').trim().split('\n');
    expect(JSON.parse(line)).toEqual(expect.objectContaining({ repository: REPO, decision: 'approved', stamp: 'abc', via: 'cli' }));
  });
});
