/**
 * The `isolation:` key a .localmostrc once used to choose an isolation type.
 * Every job now runs in a macOS VM, so a file that still has one parses,
 * with a warning, and the key is dropped: it is neither approved nor shown.
 */

import { describe, it, expect } from '@jest/globals';
import { diffConfigs, parseLocalmostrcContent, serializeLocalmostrc } from './localmostrc';
import { readPolicyEntry, recordPending } from './policy-store';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const parse = (body: string) => parseLocalmostrcContent(`version: 1\n${body}`);

describe('isolation in a .localmostrc', () => {
  it('is ignored with a warning, under shared and per workflow, whatever it says', () => {
    const result = parse(
      'shared:\n  isolation: [macos-vm, seatbelt]\n  network:\n    allow: ["github.com"]\n' +
        'workflows:\n  ui:\n    isolation: seatbelt\n  build:\n    isolation: not-a-type\n'
    );
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      'shared.isolation is ignored: every job runs in a macOS VM, so there is no isolation type to choose.',
      'workflows.ui.isolation is ignored: every job runs in a macOS VM, so there is no isolation type to choose.',
      'workflows.build.isolation is ignored: every job runs in a macOS VM, so there is no isolation type to choose.',
    ]);
    expect(result.config?.shared).toEqual({ network: { allow: ['github.com'] } });
    expect(result.config?.workflows).toEqual({ ui: {}, build: {} });
  });

  it('changes nothing an approval compares, and is not written back', () => {
    const plain = parse('shared:\n  network:\n    allow: ["github.com"]\n').config!;
    const withIsolation = parse('shared:\n  isolation: seatbelt\n  network:\n    allow: ["github.com"]\n').config!;
    expect(diffConfigs(plain, withIsolation)).toEqual([]);
    expect(serializeLocalmostrc(withIsolation)).not.toContain('isolation');
  });

  it('is dropped from a policy the approval cache kept from before', () => {
    // An approved policy cached with isolation: in it reads back without the
    // key, so the cache stays readable and the approval stays in force.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmrc-iso-'));
    try {
      recordPending(dir, 'o/r', { version: 1, shared: { isolation: 'seatbelt' } } as never);
      expect(readPolicyEntry(dir, 'o/r')?.pending?.config).toEqual({ version: 1, shared: {} });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
