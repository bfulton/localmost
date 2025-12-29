import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { parseTestArgs, TestOptions } from './test';

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
