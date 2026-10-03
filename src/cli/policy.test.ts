import { describe, it, expect, beforeEach, afterEach, afterAll } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-policy-data-'));
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-policy-repo-'));

jest.mock('../shared/paths', () => ({ getAppDataDirWithoutElectron: () => dataDir }));
jest.mock('../shared/workspace', () => ({ getRepositoryFromDir: () => 'owner/my.repo' }));

import { parsePolicyArgs, printPolicy, runPolicy } from './policy';
import { approvalStamp, approvePending, policyFilePath, readPolicyEntry, recordPending } from '../shared/policy-store';
import { parseLocalmostrcContent } from '../shared/localmostrc';
import { callInChild } from '../shared/test-utils/call-in-child';

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('CLI policy command', () => {
  describe('parsePolicyArgs', () => {
    it('returns show as default subcommand', () => {
      const result = parsePolicyArgs([]);
      expect(result.subcommand).toBe('show');
      expect(result.options).toEqual({});
    });

    it('parses show subcommand explicitly', () => {
      const result = parsePolicyArgs(['show']);
      expect(result.subcommand).toBe('show');
    });

    it('parses diff subcommand', () => {
      const result = parsePolicyArgs(['diff']);
      expect(result.subcommand).toBe('diff');
    });

    it('parses validate subcommand', () => {
      const result = parsePolicyArgs(['validate']);
      expect(result.subcommand).toBe('validate');
    });

    it('parses init subcommand', () => {
      const result = parsePolicyArgs(['init']);
      expect(result.subcommand).toBe('init');
    });

    it('parses --workflow option', () => {
      const result = parsePolicyArgs(['show', '--workflow', 'build']);
      expect(result.subcommand).toBe('show');
      expect(result.options.workflow).toBe('build');
    });

    it('parses -w short flag for workflow', () => {
      const result = parsePolicyArgs(['-w', 'deploy']);
      expect(result.options.workflow).toBe('deploy');
    });

    it('parses --force option', () => {
      const result = parsePolicyArgs(['init', '--force']);
      expect(result.subcommand).toBe('init');
      expect(result.options.force).toBe(true);
    });

    it('parses -f short flag for force', () => {
      const result = parsePolicyArgs(['init', '-f']);
      expect(result.options.force).toBe(true);
    });

    it('handles options before subcommand', () => {
      const result = parsePolicyArgs(['-w', 'ci', 'show']);
      expect(result.subcommand).toBe('show');
      expect(result.options.workflow).toBe('ci');
    });

    it('parses --stamp, which binds an approval to what was shown', () => {
      expect(parsePolicyArgs(['approve', '--stamp', 'abc']).options.stamp).toBe('abc');
    });

    it('handles multiple options', () => {
      const result = parsePolicyArgs(['show', '--workflow', 'build', '--force']);
      expect(result.subcommand).toBe('show');
      expect(result.options.workflow).toBe('build');
      expect(result.options.force).toBe(true);
    });
  });

  describe('policy validation', () => {
    // Tests for policy format validation would go here
    // These would test the validation logic from localmostrc module

    it('validates version field is required', () => {
      // Would test parseLocalmostrc validation
    });

    it('validates network.allow is array of strings', () => {
      // Would test parseLocalmostrc validation
    });

    it('validates filesystem paths are valid', () => {
      // Would test parseLocalmostrc validation
    });
  });
});

describe('policy show renders the docker grants', () => {
  const capture = (policy: unknown): string => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(' '));
    try {
      printPolicy(policy as never);
    } finally {
      console.log = original;
    }
    return lines.join('\n');
  };

  it('names every container grant, since approving is what these are shown for', () => {
    // `localmost policy approve` writes the whole .localmostrc to the cache,
    // docker section included, but `show` rendered network, filesystem and env
    // only - so the container, mount and network grants were approved unseen.
    const out = capture({
      docker: {
        pull: { registries: ['docker.io'] },
        run: {
          images: ['alpine:3'],
          mounts: [{ path: './', mode: 'ro' }],
          network: 'bridge',
          networks: [{ name: 'localmost-e2e-*', internal: true }],
        },
      },
    });
    expect(out).toMatch(/docker pull: docker\.io/);
    expect(out).toMatch(/docker run image: alpine:3/);
    expect(out).toMatch(/docker mount: \.\/ \(ro\)/);
    // Routable vs internal is the part an operator most needs to see.
    expect(out).toMatch(/docker network create: localmost-e2e-\* \(internal\)/);
  });

  it('shows a loosened level first, which is the largest grant a policy can make', () => {
    const out = capture({ level: 'permissive', network: { allow: ['github.com'] } });
    expect(out).toMatch(/Level:[\s\S]*permissive[\s\S]*Network allow/);
    expect(out).not.toMatch(/empty - uses defaults only/);
  });

  it('does not call a level-only policy empty', () => {
    expect(capture({ level: 'moderate' })).toMatch(/moderate/);
  });

  it('warns under a write the job could use to run code outside the sandbox', () => {
    const out = capture({ filesystem: { write: ['/opt/homebrew/bin', '~/.npm'] } });
    expect(out).toMatch(/\/opt\/homebrew\/bin[\s\S]*warning: on your PATH/);
    expect(out.match(/warning/g)).toHaveLength(1);
  });

  it('says nothing about docker when none is declared', () => {
    expect(capture({ network: { allow: ['github.com'] } })).not.toMatch(/docker/i);
  });
});

describe('policy show --workflow', () => {
  const originalLog = console.log;
  let output: string[];
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const show = (...args: string[]) => {
    const { subcommand, options } = parsePolicyArgs(['show', ...args]);
    runPolicy(subcommand, options);
    return output.join('\n').replace(ansi, '');
  };

  beforeEach(() => {
    output = [];
    console.log = (...args: unknown[]) => void output.push(args.join(' '));
    jest.spyOn(process, 'cwd').mockReturnValue(repoDir);
    fs.writeFileSync(
      path.join(repoDir, '.localmostrc'),
      'version: 1\nlevel: moderate\nshared:\n  network:\n    allow: [github.com]\n' +
        'workflows:\n  deploy:\n    env:\n      allow: ["FASTLANE_*"]\n    filesystem:\n      write: ["./out"]\n'
    );
  });

  afterEach(() => {
    console.log = originalLog;
    jest.restoreAllMocks();
  });

  it('keeps what the runner does not apply from a workflow marked as not applied', () => {
    // The merged view listed the workflow's env allow and filesystem grants
    // as plain effective grants, which the runner never makes.
    const out = show('--workflow', 'deploy');
    expect(out).toMatch(/FASTLANE_\*.*not applied/);
    expect(out).toMatch(/\.\/out.*not applied to runner jobs/);
    expect(out).toMatch(/deploy \(any pull request can claim this\)/);
    // The shared section and the level still apply to it, and are shown.
    expect(out).toMatch(/moderate/);
    expect(out).toMatch(/github\.com/);
  });

  it('says when the workflow has no section of its own', () => {
    const out = show('--workflow', 'build');
    expect(out).toMatch(/no section for build/i);
    expect(out).toMatch(/github\.com/);
    expect(out).not.toMatch(/FASTLANE/);
  });
});

describe('policy approve', () => {
  const policiesDir = path.join(dataDir, 'policies');
  const REPO = 'owner/my.repo';
  const PERMISSIVE = 'version: 1\nlevel: permissive\n';
  let output: string[];
  let exitSpy: jest.SpiedFunction<typeof process.exit>;
  const originalLog = console.log;

  const writeRc = (content: string) => fs.writeFileSync(path.join(repoDir, '.localmostrc'), content);
  const stampOf = (content: string) => approvalStamp(REPO, parseLocalmostrcContent(content).config!);
  const run = (...args: string[]) => {
    const { subcommand, options } = parsePolicyArgs(['approve', ...args]);
    runPolicy(subcommand, options);
  };
  const decisions = () => {
    const file = path.join(policiesDir, 'decisions.log');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };

  beforeEach(() => {
    fs.rmSync(policiesDir, { recursive: true, force: true });
    output = [];
    console.log = (...args: unknown[]) => void output.push(args.join(' '));
    jest.spyOn(process, 'cwd').mockReturnValue(repoDir);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
  });

  afterEach(() => {
    console.log = originalLog;
    jest.restoreAllMocks();
  });

  it('shows the whole policy, level first, and approves nothing without its stamp', () => {
    // Approving used to write whatever the file held and show only a diff
    // afterwards - or nothing, for a repository the runner had not seen.
    writeRc(PERMISSIVE);

    expect(() => run()).toThrow('exit 1');
    const out = output.join('\n');
    expect(out).toMatch(/permissive/);
    expect(out).toContain(`localmost policy approve --stamp ${stampOf(PERMISSIVE)}`);
    expect(readPolicyEntry(policiesDir, REPO)).toBeNull();
    expect(decisions()).toEqual([]);
  });

  it('says any pull request can claim a workflow section, and what the runner does not apply', () => {
    writeRc('version: 1\nworkflows:\n  deploy:\n    env:\n      allow: [FASTLANE_TOKEN]\n');

    expect(() => run()).toThrow('exit 1');
    // Without the CLI's colours, which sit between the words.
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
    const out = output.join('\n').replace(ansi, '');
    expect(out).toMatch(/Workflow: deploy \(any pull request can claim this\)/);
    expect(out).toMatch(/FASTLANE_TOKEN.*not applied/);
  });

  it('shows the isolation a policy with no shared section gets, which is any', () => {
    // Shown only when declared, a policy with no isolation: said nothing of
    // it, though its jobs get the strongest type this Mac allows.
    writeRc('version: 1\nworkflows:\n  deploy:\n    network:\n      allow: [x.com]\n');

    expect(() => run()).toThrow('exit 1');
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
    const out = output.join('\n').replace(ansi, '');
    expect(out).toMatch(/Shared policy:\n {2}Isolation:\n {4}~ any \(macos-vm, service-account, seatbelt\) \(not declared, so the default;/);
  });

  it('approves exactly the policy whose stamp it was given, and records it', () => {
    writeRc(PERMISSIVE);
    run('--stamp', stampOf(PERMISSIVE));

    expect(exitSpy).not.toHaveBeenCalled();
    expect(readPolicyEntry(policiesDir, REPO)?.approved?.config).toEqual(expect.objectContaining({ level: 'permissive' }));
    expect(decisions()).toEqual([
      expect.objectContaining({ repository: REPO, decision: 'approved', stamp: stampOf(PERMISSIVE), via: 'cli' }),
    ]);
  });

  it('refuses a stamp for a policy the file no longer holds', () => {
    const shown = 'version: 1\nshared:\n  network:\n    allow:\n      - "index.crates.io"\n';
    writeRc(PERMISSIVE);

    expect(() => run('--stamp', stampOf(shown))).toThrow('exit 1');
    expect(output.join('\n')).toMatch(/changed/);
    expect(readPolicyEntry(policiesDir, REPO)).toBeNull();
  });

  it('leaves a different pending policy waiting for its own decision', () => {
    const other = parseLocalmostrcContent('version: 1\nlevel: moderate\n').config!;
    recordPending(policiesDir, REPO, other);
    writeRc(PERMISSIVE);
    run('--stamp', stampOf(PERMISSIVE));

    const entry = readPolicyEntry(policiesDir, REPO)!;
    expect(entry.approved?.config.level).toBe('permissive');
    expect(entry.pending?.config).toEqual(other);
  });

  it('says when the same policy is waiting from a different repository, and keeps the approval where it was', () => {
    // A repository that took the name copies the approved file byte for
    // byte. The CLI's diff reads "None", so it has to say whose request
    // this is - and must not move the approval to it.
    const config = parseLocalmostrcContent(PERMISSIVE).config!;
    recordPending(policiesDir, REPO, config, 1);
    approvePending(policiesDir, REPO, approvalStamp(REPO, config, 1));
    recordPending(policiesDir, REPO, config, 2);
    writeRc(PERMISSIVE);

    expect(() => run()).toThrow('exit 1');
    expect(output.join('\n')).toMatch(/repository id 2[\s\S]*bound to repository id 1[\s\S]*Job Security/);

    output = [];
    run('--stamp', stampOf(PERMISSIVE));
    const entry = readPolicyEntry(policiesDir, REPO)!;
    expect(entry.approved?.repositoryId).toBe(1);
    expect(entry.pending?.repositoryId).toBe(2);
    expect(output.join('\n')).toMatch(/repository id 2 is still waiting/);
  });

  it('approves over a cache entry that no longer reads', () => {
    // An entry from an older grammar used to make approving throw, and the
    // only way to approve the repository again was deleting it by hand.
    fs.mkdirSync(policiesDir, { recursive: true });
    fs.writeFileSync(
      policyFilePath(policiesDir, REPO),
      JSON.stringify({ repository: REPO, config: { version: 1, shared: { sockets: {} } }, cachedAt: '', approved: true })
    );
    writeRc(PERMISSIVE);
    run('--stamp', stampOf(PERMISSIVE));

    expect(exitSpy).not.toHaveBeenCalled();
    expect(readPolicyEntry(policiesDir, REPO)?.approved?.config.level).toBe('permissive');
  });

  it('says why an approval could not be written, rather than crashing', () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(policiesDir, 'not a directory');
    writeRc(PERMISSIVE);
    try {
      expect(() => run('--stamp', stampOf(PERMISSIVE))).toThrow('exit 1');
      expect(output.join('\n')).toMatch(/Could not approve/);
    } finally {
      fs.rmSync(policiesDir, { force: true });
    }
  });

  it('keeps an approval whose decision could not be logged, and says so', () => {
    // The approval is already written by then; failing the command would say
    // it had not happened.
    fs.mkdirSync(path.join(policiesDir, 'decisions.log'), { recursive: true });
    writeRc(PERMISSIVE);
    run('--stamp', stampOf(PERMISSIVE));

    expect(exitSpy).not.toHaveBeenCalled();
    expect(readPolicyEntry(policiesDir, REPO)?.approved?.config.level).toBe('permissive');
    expect(output.join('\n')).toMatch(/Could not record/);
  });
});

describe('policy init', () => {
  const originalLog = console.log;
  let root: string;
  let dir: string;
  let outside: string;
  let output: string[];
  const rc = () => path.join(dir, '.localmostrc');
  const SENTINEL = 'version: 1\nlevel: permissive\n# mine\n';

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-policy-init-')));
    dir = path.join(root, 'repo');
    outside = path.join(root, 'outside');
    fs.mkdirSync(dir);
    fs.mkdirSync(outside);
    output = [];
    console.log = (...args: unknown[]) => void output.push(args.join(' '));
    jest.spyOn(process, 'cwd').mockReturnValue(dir);
  });

  afterEach(() => {
    console.log = originalLog;
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates the template when there is no policy', () => {
    runPolicy('init', {});
    const written = parseLocalmostrcContent(fs.readFileSync(rc(), 'utf-8'));
    expect(written.errors).toEqual([]);
    expect(written.config?.level).toBe('strict');
  });

  it('leaves an existing policy byte for byte without --force', () => {
    fs.writeFileSync(rc(), SENTINEL);
    runPolicy('init', {});
    expect(fs.readFileSync(rc(), 'utf-8')).toBe(SENTINEL);
    expect(output.join('\n')).toMatch(/already exists/);
  });

  it('replaces an existing policy with --force, which it used to parse and ignore', () => {
    fs.writeFileSync(rc(), SENTINEL);
    runPolicy('init', { force: true });
    const text = fs.readFileSync(rc(), 'utf-8');
    expect(text).not.toBe(SENTINEL);
    expect(parseLocalmostrcContent(text).config?.level).toBe('strict');
    expect(fs.readdirSync(dir)).toEqual(['.localmostrc']);
  });

  it('creates .localmostrc beside a .localmostrc.yml, which is no policy, and leaves that file alone', () => {
    // The runner reads only .localmostrc, so the .yml was never a policy a
    // job got; the new file is the one both will read.
    fs.writeFileSync(path.join(dir, '.localmostrc.yml'), SENTINEL);
    runPolicy('init', {});
    expect(parseLocalmostrcContent(fs.readFileSync(rc(), 'utf-8')).config?.level).toBe('strict');
    expect(fs.readFileSync(path.join(dir, '.localmostrc.yml'), 'utf-8')).toBe(SENTINEL);
    expect(output.join('\n')).toMatch(/Created \.localmostrc$/m);
    // And says so, as the other subcommands do, so the .yml's grants do not
    // look carried over.
    expect(output.join('\n')).toMatch(/\.localmostrc\.yml is not read: .*rename it first to keep its grants/);
  });

  it.each(['show', 'validate', 'diff', 'approve'])(
    'policy %s says a .localmostrc.yml is not read, rather than only that there is no policy',
    (subcommand) => {
      fs.writeFileSync(path.join(dir, '.localmostrc.yml'), SENTINEL);
      jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as never);
      try {
        runPolicy(subcommand, {});
      } catch (err) {
        // validate fails a checkout with no policy; the others just say so.
        expect((err as Error).message).toBe('exit 1');
      }
      const text = output.join('\n');
      expect(text).toMatch(/No \.localmostrc found/);
      expect(text).toMatch(/\.localmostrc\.yml is not read: .*Rename it to \.localmostrc/);
    }
  );

  it.each([
    ['without --force', {}],
    ['with --force', { force: true }],
  ])('refuses a dangling link %s, and creates nothing where it points', (_label, options) => {
    const victim = path.join(outside, '.zshenv');
    fs.symlinkSync(victim, rc());
    expect(() => runPolicy('init', options)).toThrow(/\.localmostrc is not a regular file/);
    expect(fs.existsSync(victim)).toBe(false);
    expect(fs.readlinkSync(rc())).toBe(victim);
  });

  it('refuses a link to a file outside the checkout with --force, and leaves that file alone', () => {
    const target = path.join(outside, 'target');
    fs.writeFileSync(target, SENTINEL);
    fs.symlinkSync(target, rc());
    expect(() => runPolicy('init', { force: true })).toThrow(/not a regular file/);
    expect(fs.readFileSync(target, 'utf-8')).toBe(SENTINEL);
    expect(fs.readlinkSync(rc())).toBe(target);
  });
});

describe('what policy commands read at .localmostrc', () => {
  it.each(['show', 'validate', 'diff', 'init'])(
    'policy %s refuses a link to /dev/zero without reading it',
    (subcommand) => {
      // In a child: reading /dev/zero never ends, and would hang the suite.
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-policy-zero-')));
      try {
        fs.symlinkSync('/dev/zero', path.join(root, '.localmostrc'));
        const result = callInChild(path.join(__dirname, 'policy.ts'), 'runPolicy', [subcommand, {}], {
          cwd: root,
          env: { ...process.env, HOME: root },
          timeoutMs: 15_000,
        });
        expect(result.timedOut).toBe(false);
        expect(result.status).not.toBe(0);
        expect(result.output).toMatch(/\.localmostrc is not a regular file/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    30_000
  );
});
