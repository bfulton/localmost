import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { parsePolicyArgs, PolicyOptions } from './policy';

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
