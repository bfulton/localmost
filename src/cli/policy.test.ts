import { describe, it, expect } from '@jest/globals';
import { parsePolicyArgs, printPolicy } from './policy';

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

  it('says nothing about docker when none is declared', () => {
    expect(capture({ network: { allow: ['github.com'] } })).not.toMatch(/docker/i);
  });
});
