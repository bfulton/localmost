import { describe, it, expect } from '@jest/globals';
import {
  parseTargetsArgs,
  parseTargetRef,
  formatTargets,
  formatMutation,
  findSummaryByRef,
  runTargets,
  TargetSummary,
  TargetsDeps,
} from './targets';
import type { CliRequest, CliResponse } from '../shared/cli-protocol';

describe('CLI targets command', () => {
  describe('parseTargetsArgs', () => {
    it('returns list as default subcommand', () => {
      const result = parseTargetsArgs([]);
      expect(result.subcommand).toBe('list');
      expect(result.ref).toBeUndefined();
      expect(result.options).toEqual({});
    });

    it('parses list subcommand explicitly', () => {
      const result = parseTargetsArgs(['list']);
      expect(result.subcommand).toBe('list');
    });

    it('parses add subcommand with a repo ref', () => {
      const result = parseTargetsArgs(['add', 'bfulton/voight-kampff']);
      expect(result.subcommand).toBe('add');
      expect(result.ref).toBe('bfulton/voight-kampff');
    });

    it('parses --org flag', () => {
      const result = parseTargetsArgs(['add', 'bfulton', '--org']);
      expect(result.subcommand).toBe('add');
      expect(result.ref).toBe('bfulton');
      expect(result.options.org).toBe(true);
    });

    it('parses --yes flag', () => {
      const result = parseTargetsArgs(['remove', 'bfulton/supdb', '--yes']);
      expect(result.subcommand).toBe('remove');
      expect(result.ref).toBe('bfulton/supdb');
      expect(result.options.yes).toBe(true);
    });

    it('parses -y short flag for yes', () => {
      const result = parseTargetsArgs(['remove', 'bfulton/supdb', '-y']);
      expect(result.options.yes).toBe(true);
    });

    it('parses --json flag', () => {
      const result = parseTargetsArgs(['list', '--json']);
      expect(result.subcommand).toBe('list');
      expect(result.options.json).toBe(true);
    });

    it('parses enable subcommand', () => {
      const result = parseTargetsArgs(['enable', 'bfulton/supdb']);
      expect(result.subcommand).toBe('enable');
      expect(result.ref).toBe('bfulton/supdb');
    });

    it('parses disable subcommand', () => {
      const result = parseTargetsArgs(['disable', 'bfulton/supdb']);
      expect(result.subcommand).toBe('disable');
      expect(result.ref).toBe('bfulton/supdb');
    });

    it('handles flags before the ref', () => {
      const result = parseTargetsArgs(['remove', '--yes', 'bfulton/supdb']);
      expect(result.subcommand).toBe('remove');
      expect(result.ref).toBe('bfulton/supdb');
      expect(result.options.yes).toBe(true);
    });

    it('rejects an unknown subcommand', () => {
      expect(() => parseTargetsArgs(['frobnicate'])).toThrow(/unknown subcommand/i);
    });

    it('rejects an unknown flag', () => {
      expect(() => parseTargetsArgs(['add', 'bfulton/supdb', '--bogus'])).toThrow(/unknown option/i);
    });

    it('rejects a second positional argument', () => {
      expect(() => parseTargetsArgs(['add', 'bfulton/supdb', 'extra'])).toThrow(/too many arguments/i);
    });
  });

  describe('parseTargetRef', () => {
    it('parses owner/repo into a repo target', () => {
      expect(parseTargetRef('bfulton/voight-kampff', {})).toEqual({
        type: 'repo',
        owner: 'bfulton',
        repo: 'voight-kampff',
      });
    });

    it('parses a bare owner into an org target when --org is set', () => {
      expect(parseTargetRef('bfulton', { org: true })).toEqual({
        type: 'org',
        owner: 'bfulton',
      });
    });

    it('rejects a bare owner without --org', () => {
      expect(() => parseTargetRef('bfulton', {})).toThrow(/owner\/repo/i);
    });

    it('rejects owner/repo with --org', () => {
      expect(() => parseTargetRef('bfulton/supdb', { org: true })).toThrow(/--org/i);
    });

    it('rejects more than one slash', () => {
      expect(() => parseTargetRef('a/b/c', {})).toThrow(/invalid target/i);
    });

    it('rejects an empty ref', () => {
      expect(() => parseTargetRef('', {})).toThrow(/invalid target/i);
    });

    it('rejects an empty repo half', () => {
      expect(() => parseTargetRef('bfulton/', {})).toThrow(/invalid target/i);
    });
  });
});

describe('CLI targets output', () => {
  const summaries: TargetSummary[] = [
    {
      id: '3116ec9a',
      displayName: 'bfulton/supdb',
      type: 'repo',
      url: 'https://github.com/bfulton/supdb',
      enabled: true,
      proxyRunnerName: 'localmost.blue-243.bfulton-supdb',
      runnerCount: 4,
      addedAt: '2026-08-22T14:33:57.884Z',
    },
    {
      id: '26c43c63',
      displayName: 'bfulton/localmost',
      type: 'repo',
      url: 'https://github.com/bfulton/localmost',
      enabled: false,
      proxyRunnerName: 'localmost.blue-243.bfulton-localmost',
      runnerCount: 4,
      addedAt: '2026-08-29T17:01:55.242Z',
    },
  ];

  describe('formatTargets', () => {
    it('lists each target by display name', () => {
      const output = formatTargets(summaries, {});
      expect(output).toContain('bfulton/supdb');
      expect(output).toContain('bfulton/localmost');
    });

    it('reports the runner count and proxy runner name', () => {
      const output = formatTargets(summaries, {});
      expect(output).toContain('4 runners');
      expect(output).toContain('localmost.blue-243.bfulton-supdb');
    });

    it('marks disabled targets', () => {
      const output = formatTargets(summaries, {});
      expect(output).toMatch(/bfulton\/localmost.*disabled/s);
    });

    it('says so when there are no targets', () => {
      expect(formatTargets([], {})).toMatch(/no targets/i);
    });

    it('emits the raw summaries as JSON with --json', () => {
      expect(JSON.parse(formatTargets(summaries, { json: true }))).toEqual(summaries);
    });

    it('emits an empty JSON array when there are no targets', () => {
      expect(JSON.parse(formatTargets([], { json: true }))).toEqual([]);
    });
  });

  describe('formatMutation', () => {
    it('describes an added target', () => {
      const output = formatMutation('added', summaries[0], {});
      expect(output).toMatch(/added/i);
      expect(output).toContain('bfulton/supdb');
      expect(output).toContain('4 runners');
    });

    it('describes a removed target', () => {
      const output = formatMutation('removed', summaries[0], {});
      expect(output).toMatch(/removed/i);
      expect(output).toContain('bfulton/supdb');
    });

    it('emits the target as JSON with --json', () => {
      const output = formatMutation('added', summaries[0], { json: true });
      expect(JSON.parse(output)).toEqual({ action: 'added', target: summaries[0] });
    });
  });
});

describe('findSummaryByRef', () => {
  const summary: TargetSummary = {
    id: '3116ec9a',
    displayName: 'bfulton/supdb',
    type: 'repo',
    url: 'https://github.com/bfulton/supdb',
    enabled: true,
    proxyRunnerName: 'localmost.blue-243.bfulton-supdb',
    runnerCount: 4,
    addedAt: '2026-08-22T14:33:57.884Z',
  };

  it('matches on display name', () => {
    expect(findSummaryByRef([summary], 'bfulton/supdb')).toEqual(summary);
  });

  it('matches on id', () => {
    expect(findSummaryByRef([summary], '3116ec9a')).toEqual(summary);
  });

  it('ignores case', () => {
    expect(findSummaryByRef([summary], 'BFulton/SupDB')).toEqual(summary);
  });

  it('returns undefined when nothing matches', () => {
    expect(findSummaryByRef([summary], 'bfulton/other')).toBeUndefined();
  });

  it('prefers an exact match over a case-insensitive one', () => {
    const variant = { ...summary, id: 'other', displayName: 'BFulton/SupDB' };
    expect(findSummaryByRef([variant, summary], 'bfulton/supdb')?.id).toBe('3116ec9a');
  });

  it('returns undefined when several targets match only by case', () => {
    const variant = { ...summary, id: 'other', displayName: 'BFulton/SupDB' };
    expect(findSummaryByRef([variant, summary], 'BFULTON/SUPDB')).toBeUndefined();
  });
});

describe('runTargets', () => {
  const summary: TargetSummary = {
    id: '3116ec9a',
    displayName: 'bfulton/supdb',
    type: 'repo',
    url: 'https://github.com/bfulton/supdb',
    enabled: true,
    proxyRunnerName: 'localmost.blue-243.bfulton-supdb',
    runnerCount: 4,
    addedAt: '2026-08-22T14:33:57.884Z',
  };

  let sent: CliRequest[];
  let stdout: string[];
  let stderr: string[];
  let prompts: string[];

  const makeDeps = (
    responder: (request: CliRequest) => CliResponse,
    io?: Partial<TargetsDeps['io']>
  ): TargetsDeps => ({
    send: async (request: CliRequest) => {
      sent.push(request);
      return responder(request);
    },
    io: {
      isTTY: true,
      prompt: async (question: string) => {
        prompts.push(question);
        return 'y';
      },
      ...io,
    },
    out: (line: string) => stdout.push(line),
    err: (line: string) => stderr.push(line),
  });

  beforeEach(() => {
    sent = [];
    stdout = [];
    stderr = [];
    prompts = [];
  });

  const listResponder = (): CliResponse => ({
    success: true,
    command: 'targets-list',
    data: { targets: [summary] },
  });

  it('lists targets', async () => {
    const code = await runTargets('list', undefined, {}, makeDeps(listResponder));

    expect(code).toBe(0);
    expect(sent).toEqual([{ command: 'targets-list' }]);
    expect(stdout.join('\n')).toContain('bfulton/supdb');
  });

  it('lists targets as JSON with --json', async () => {
    const code = await runTargets('list', undefined, { json: true }, makeDeps(listResponder));

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join('\n'))).toEqual([summary]);
  });

  it('adds a repo target', async () => {
    const code = await runTargets('add', 'bfulton/supdb', {}, makeDeps(() => ({
      success: true,
      command: 'targets-add',
      data: { target: summary },
    })));

    expect(code).toBe(0);
    expect(sent).toEqual([
      { command: 'targets-add', args: { type: 'repo', owner: 'bfulton', repo: 'supdb' } },
    ]);
    expect(stdout.join('\n')).toContain('bfulton/supdb');
  });

  it('adds an org target with --org', async () => {
    const code = await runTargets('add', 'bfulton', { org: true }, makeDeps(() => ({
      success: true,
      command: 'targets-add',
      data: { target: summary },
    })));

    expect(code).toBe(0);
    expect(sent).toEqual([{ command: 'targets-add', args: { type: 'org', owner: 'bfulton' } }]);
  });

  it('names every accepted ref form when remove is given no target', async () => {
    const code = await runTargets('remove', undefined, {}, makeDeps(listResponder));

    expect(code).toBe(1);
    expect(sent).toHaveLength(0);
    expect(stderr.join('\n')).toMatch(/target id/i);
  });

  it('fails when add is given no target', async () => {
    const code = await runTargets('add', undefined, {}, makeDeps(listResponder));

    expect(code).toBe(1);
    expect(sent).toHaveLength(0);
    expect(stderr.join('\n')).toMatch(/owner\/repo/i);
  });

  it('reports an error response and exits non-zero', async () => {
    const code = await runTargets('add', 'bfulton/supdb', {}, makeDeps(() => ({
      success: false,
      error: 'This target already exists',
    })));

    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('This target already exists');
  });

  it('confirms before removing on a TTY', async () => {
    const code = await runTargets('remove', 'bfulton/supdb', {}, makeDeps(request =>
      request.command === 'targets-list'
        ? listResponder()
        : { success: true, command: 'targets-remove', data: { target: summary } }
    ));

    expect(code).toBe(0);
    expect(prompts.join('\n')).toContain('bfulton/supdb');
    expect(prompts.join('\n')).toContain('4 runners');
    expect(sent.map(r => r.command)).toEqual(['targets-list', 'targets-remove']);
    expect(sent[1].args).toEqual({ ref: 'bfulton/supdb' });
  });

  it('aborts the removal when the prompt is declined', async () => {
    const code = await runTargets('remove', 'bfulton/supdb', {}, makeDeps(listResponder, {
      prompt: async () => 'n',
    }));

    expect(code).toBe(1);
    expect(sent.map(r => r.command)).toEqual(['targets-list']);
    expect(stderr.join('\n')).toMatch(/abort/i);
  });

  it('skips the prompt with --yes', async () => {
    const code = await runTargets('remove', 'bfulton/supdb', { yes: true }, makeDeps(request =>
      request.command === 'targets-list'
        ? listResponder()
        : { success: true, command: 'targets-remove', data: { target: summary } }
    ));

    expect(code).toBe(0);
    expect(prompts).toHaveLength(0);
    expect(sent.map(r => r.command)).toEqual(['targets-list', 'targets-remove']);
  });

  it('refuses to remove without --yes when not on a TTY', async () => {
    const code = await runTargets('remove', 'bfulton/supdb', {}, makeDeps(listResponder, {
      isTTY: false,
    }));

    expect(code).toBe(1);
    expect(sent.map(r => r.command)).toEqual(['targets-list']);
    expect(stderr.join('\n')).toContain('--yes');
  });

  it('fails when the target to remove is unknown', async () => {
    const code = await runTargets('remove', 'bfulton/nope', { yes: true }, makeDeps(listResponder));

    expect(code).toBe(1);
    expect(sent.map(r => r.command)).toEqual(['targets-list']);
    expect(stderr.join('\n')).toContain('bfulton/nope');
  });

  it('disables a target', async () => {
    const code = await runTargets('disable', 'bfulton/supdb', {}, makeDeps(() => ({
      success: true,
      command: 'targets-update',
      data: { target: { ...summary, enabled: false } },
    })));

    expect(code).toBe(0);
    expect(sent).toEqual([
      { command: 'targets-update', args: { ref: 'bfulton/supdb', enabled: false } },
    ]);
  });

  it('enables a target', async () => {
    const code = await runTargets('enable', 'bfulton/supdb', {}, makeDeps(() => ({
      success: true,
      command: 'targets-update',
      data: { target: summary },
    })));

    expect(code).toBe(0);
    expect(sent).toEqual([
      { command: 'targets-update', args: { ref: 'bfulton/supdb', enabled: true } },
    ]);
  });

  it('emits JSON for a mutation with --json', async () => {
    const code = await runTargets('add', 'bfulton/supdb', { json: true }, makeDeps(() => ({
      success: true,
      command: 'targets-add',
      data: { target: summary },
    })));

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join('\n'))).toEqual({ action: 'added', target: summary });
  });

  it('emits JSON for an error with --json', async () => {
    const code = await runTargets('add', 'bfulton/supdb', { json: true }, makeDeps(() => ({
      success: false,
      error: 'This target already exists',
    })));

    expect(code).toBe(1);
    expect(JSON.parse(stderr.join('\n'))).toEqual({ error: 'This target already exists' });
  });
});
