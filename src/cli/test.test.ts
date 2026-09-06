import { describe, it, expect } from '@jest/globals';
import { parseTestArgs, extractJobOutputs, extractWorkflowOutputs, mergeDiscoveredAccess, DiscoveredAccess } from './test';
import { LocalmostrcConfig, LOCALMOSTRC_VERSION } from '../shared/localmostrc';

describe('CLI test command', () => {
  describe('parseTestArgs', () => {
    it('parses empty args', () => {
      const result = parseTestArgs([]);
      expect(result).toEqual({});
    });

    it('parses workflow argument', () => {
      const result = parseTestArgs(['build.yml']);
      expect(result.workflow).toBe('build.yml');
    });

    it('parses --updaterc flag', () => {
      const result = parseTestArgs(['--updaterc']);
      expect(result.updaterc).toBe(true);
    });

    it('parses -u short flag', () => {
      const result = parseTestArgs(['-u']);
      expect(result.updaterc).toBe(true);
    });

    it('parses --full-matrix flag', () => {
      const result = parseTestArgs(['--full-matrix']);
      expect(result.fullMatrix).toBe(true);
    });

    it('parses -f short flag for full-matrix', () => {
      const result = parseTestArgs(['-f']);
      expect(result.fullMatrix).toBe(true);
    });

    it('parses --matrix with value', () => {
      const result = parseTestArgs(['--matrix', 'os=macos,node=18']);
      expect(result.matrix).toBe('os=macos,node=18');
    });

    it('parses -m short flag for matrix', () => {
      const result = parseTestArgs(['-m', 'os=ubuntu']);
      expect(result.matrix).toBe('os=ubuntu');
    });

    it('parses --job with value', () => {
      const result = parseTestArgs(['--job', 'build-ios']);
      expect(result.job).toBe('build-ios');
    });

    it('parses -j short flag for job', () => {
      const result = parseTestArgs(['-j', 'test']);
      expect(result.job).toBe('test');
    });

    it('parses --dry-run flag', () => {
      const result = parseTestArgs(['--dry-run']);
      expect(result.dryRun).toBe(true);
    });

    it('parses -n short flag for dry-run', () => {
      const result = parseTestArgs(['-n']);
      expect(result.dryRun).toBe(true);
    });

    it('parses --verbose flag', () => {
      const result = parseTestArgs(['--verbose']);
      expect(result.verbose).toBe(true);
    });

    it('parses -v short flag for verbose', () => {
      const result = parseTestArgs(['-v']);
      expect(result.verbose).toBe(true);
    });

    it('parses --staged flag', () => {
      const result = parseTestArgs(['--staged']);
      expect(result.staged).toBe(true);
    });

    it('parses --no-ignore flag', () => {
      const result = parseTestArgs(['--no-ignore']);
      expect(result.noIgnore).toBe(true);
    });

    it('parses --env flag', () => {
      const result = parseTestArgs(['--env']);
      expect(result.showEnv).toBe(true);
    });

    it('parses -e short flag for env', () => {
      const result = parseTestArgs(['-e']);
      expect(result.showEnv).toBe(true);
    });

    it('parses --secrets with valid mode', () => {
      const result = parseTestArgs(['--secrets', 'stub']);
      expect(result.secretMode).toBe('stub');
    });

    it('parses --secrets with prompt mode', () => {
      const result = parseTestArgs(['--secrets', 'prompt']);
      expect(result.secretMode).toBe('prompt');
    });

    it('parses --secrets with abort mode', () => {
      const result = parseTestArgs(['--secrets', 'abort']);
      expect(result.secretMode).toBe('abort');
    });

    it('throws for invalid secrets mode', () => {
      expect(() => parseTestArgs(['--secrets', 'invalid'])).toThrow('Invalid secrets mode');
    });

    it('parses multiple flags together', () => {
      const result = parseTestArgs([
        'ci.yml',
        '--job', 'build',
        '--verbose',
        '--dry-run',
        '--env',
      ]);
      expect(result).toEqual({
        workflow: 'ci.yml',
        job: 'build',
        verbose: true,
        dryRun: true,
        showEnv: true,
      });
    });

    it('handles workflow argument anywhere in args', () => {
      const result = parseTestArgs(['--verbose', 'build.yml', '--dry-run']);
      expect(result.workflow).toBe('build.yml');
      expect(result.verbose).toBe(true);
      expect(result.dryRun).toBe(true);
    });
  });

  describe('formatDuration (test helper)', () => {
    // Test the duration formatting logic that would be used in output
    function formatDuration(ms: number): string {
      if (ms < 1000) {
        return `${ms}ms`;
      }
      const seconds = ms / 1000;
      if (seconds < 60) {
        return `${seconds.toFixed(1)}s`;
      }
      const minutes = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${minutes}m ${secs}s`;
    }

    it('formats milliseconds', () => {
      expect(formatDuration(500)).toBe('500ms');
    });

    it('formats seconds with decimal', () => {
      expect(formatDuration(2500)).toBe('2.5s');
    });

    it('formats minutes and seconds', () => {
      expect(formatDuration(125000)).toBe('2m 5s');
    });
  });
});

describe('output expression resolution', () => {
  // GitHub Actions allows hyphens in step ids, job ids and output names, e.g.
  // ${{ steps.build-image.outputs.docker-tag }}. A \w-only pattern silently
  // fails to resolve those, leaving the expression unsubstituted.
  it('resolves step outputs whose ids contain hyphens', () => {
    const job = { outputs: { image: '${{ steps.build-image.outputs.docker-tag }}' } };
    const stepOutputs = { 'build-image': { 'docker-tag': 'sha-abc123' } };

    expect(extractJobOutputs(job as never, stepOutputs)).toEqual({ image: 'sha-abc123' });
  });

  it('resolves workflow outputs whose job ids contain hyphens', () => {
    const workflow = {
      outputs: { image: { value: '${{ jobs.build-image.outputs.docker-tag }}' } },
    };
    const jobOutputs = { 'build-image': { 'docker-tag': 'sha-abc123' } };

    expect(extractWorkflowOutputs(workflow as never, jobOutputs as never)).toEqual({
      image: 'sha-abc123',
    });
  });
});

describe('mergeDiscoveredAccess', () => {
  const discovered = (partial: Partial<DiscoveredAccess>): DiscoveredAccess => ({
    hosts: [], readPaths: [], writePaths: [], ...partial,
  });

  it('adds the hosts and paths an existing policy lacks, and lists only those', () => {
    const existing: LocalmostrcConfig = {
      version: 1,
      shared: { network: { allow: ['github.com'] }, filesystem: { read: ['/usr'] } },
      workflows: { deploy: { network: { allow: ['api.example.com'] } } },
    };

    const { config, additions } = mergeDiscoveredAccess(existing, discovered({
      hosts: ['github.com', 'registry.npmjs.org'],
      readPaths: ['/usr', '/opt/homebrew'],
      writePaths: ['~/Library/Caches/pip'],
    }), 'ci');

    expect(config.shared?.network?.allow).toEqual(['github.com', 'registry.npmjs.org']);
    expect(config.shared?.filesystem?.read).toEqual(['/usr', '/opt/homebrew']);
    expect(config.shared?.filesystem?.write).toEqual(['~/Library/Caches/pip']);
    expect(config.workflows).toEqual(existing.workflows);
    expect(additions).toEqual([
      { label: 'network.allow', items: ['registry.npmjs.org'] },
      { label: 'filesystem.read', items: ['/opt/homebrew'] },
      { label: 'filesystem.write', items: ['~/Library/Caches/pip'] },
    ]);
  });

  it('has nothing to add when the existing policy already covers what was discovered', () => {
    const existing: LocalmostrcConfig = { version: 1, shared: { network: { allow: ['github.com'] } } };

    const { additions } = mergeDiscoveredAccess(existing, discovered({ hosts: ['github.com'] }), 'ci');

    expect(additions).toEqual([]);
  });

  it('starts a new policy from the discovered access, with an empty entry for the workflow', () => {
    const { config, additions } = mergeDiscoveredAccess(undefined, discovered({
      hosts: ['github.com'],
      writePaths: ['~/.npm'],
    }), 'ci');

    expect(config).toEqual({
      version: LOCALMOSTRC_VERSION,
      shared: { network: { allow: ['github.com'] }, filesystem: { write: ['~/.npm'] } },
      workflows: { ci: {} },
    });
    expect(additions).toEqual([
      { label: 'network.allow', items: ['github.com'] },
      { label: 'filesystem.write', items: ['~/.npm'] },
    ]);
  });

  it('turns a denied docker request into a docker policy suggestion in --updaterc output', () => {
    // What a filtered denial logs: the YAML under docker: that would have permitted the request.
    const hint = 'docker:\n  run:\n    images:\n      - "postgres:16"';
    const existing: LocalmostrcConfig = { version: 1, shared: { network: { allow: ['github.com'] } } };

    const { config, additions } = mergeDiscoveredAccess(existing, discovered({ dockerHints: [hint] }), 'ci');

    expect(config.shared?.docker?.run?.images).toContain('postgres:16');
    expect(config.shared?.network?.allow).toEqual(['github.com']);
    expect(additions).toEqual([{ label: 'docker.run.images', items: ['postgres:16'] }]);
  });

  it('folds several docker denials into one policy and adds only what the existing one lacks', () => {
    const existing: LocalmostrcConfig = {
      version: 1,
      shared: { docker: { run: { images: ['postgres:16'], network: 'bridge' } } },
    };
    const hints = [
      'docker:\n  run:\n    images:\n      - "postgres:16"',
      'docker:\n  run:\n    images:\n      - "redis:7"',
      'docker:\n  run:\n    mounts:\n      - path: "./tmp/fixtures"\n        mode: rw',
      'docker:\n  pull:\n    registries:\n      - ghcr.io',
    ];

    const { config, additions } = mergeDiscoveredAccess(existing, discovered({ dockerHints: hints }), 'ci');

    expect(config.shared?.docker).toEqual({
      pull: { registries: ['ghcr.io'] },
      run: { images: ['postgres:16', 'redis:7'], mounts: [{ path: './tmp/fixtures', mode: 'rw' }], network: 'bridge' },
    });
    expect(additions).toEqual([
      { label: 'docker.pull.registries', items: ['ghcr.io'] },
      { label: 'docker.run.images', items: ['redis:7'] },
      { label: 'docker.run.mounts', items: ['./tmp/fixtures:rw'] },
    ]);
  });

  it('has nothing to add when the existing docker policy already permits the denied request', () => {
    const existing: LocalmostrcConfig = { version: 1, shared: { docker: { run: { images: ['postgres:16'] } } } };
    const hint = 'docker:\n  run:\n    images:\n      - "postgres:16"';

    const { config, additions } = mergeDiscoveredAccess(existing, discovered({ dockerHints: [hint] }), 'ci');

    expect(additions).toEqual([]);
    expect(config.shared?.docker).toEqual(existing.shared?.docker);
  });

  it('lists a bare run action as its own grant, since the diff has no item to show for it', () => {
    const existing: LocalmostrcConfig = { version: 1, shared: { docker: { pull: { registries: ['docker.io'] } } } };

    const { config, additions } = mergeDiscoveredAccess(existing, discovered({ dockerHints: ['docker:\n  run: {}'] }), 'ci');

    expect(config.shared?.docker).toEqual({ pull: { registries: ['docker.io'] }, run: {} });
    expect(additions).toEqual([{ label: 'docker.run', items: ['{}'] }]);
  });

  it('starts a new policy with a docker block from the hints alone', () => {
    const { config, additions } = mergeDiscoveredAccess(undefined, discovered({
      dockerHints: ['docker:\n  build:\n    context: "./"'],
    }), 'ci');

    expect(config.shared?.docker).toEqual({ build: { context: './' } });
    expect(config.workflows).toEqual({ ci: {} });
    expect(additions).toEqual([{ label: 'docker.build.context', items: ['./'] }]);
  });

  it('ignores a hint that is not a valid docker policy rather than widening the file', () => {
    const { config, additions } = mergeDiscoveredAccess(undefined, discovered({ dockerHints: ['docker: socket'] }), 'ci');

    expect(config.shared?.docker).toBeUndefined();
    expect(additions).toEqual([]);
  });
});
