import { jest } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';

// writeFileSync is a pass-through that a test can make fail partway.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs') as typeof import('fs');
  return { ...actual, writeFileSync: jest.fn(actual.writeFileSync) };
});

let mockRunnerDir = '';
jest.mock('../paths', () => ({ getRunnerDir: () => mockRunnerDir }));
jest.mock('../app-state', () => ({ getLogger: () => null }));

import * as fs from 'fs';
import { SessionPersistence } from './session-persistence';

describe('SessionPersistence', () => {
  const actualWriteFileSync = (jest.requireActual('fs') as typeof import('fs')).writeFileSync;

  beforeEach(() => {
    mockRunnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-persistence-'));
  });

  afterEach(() => {
    jest.mocked(fs.writeFileSync).mockImplementation(actualWriteFileSync);
    fs.rmSync(mockRunnerDir, { recursive: true, force: true });
  });

  /**
   * The next write dies partway, as a full disk or a crash leaves one: a few
   * bytes reach the file it was writing, then it fails.
   */
  const failNextWritePartway = () => {
    jest.mocked(fs.writeFileSync).mockImplementationOnce((file, data) => {
      actualWriteFileSync(file, String(data).slice(0, 5));
      throw new Error('ENOSPC: no space left on device');
    });
  };

  it('keeps the saved sessions whole when a save fails partway, and leaves nothing beside them', () => {
    // A half-written file does not parse, and load() reads that as no
    // sessions: those the last run left upstream are never cleaned up.
    const persistence = new SessionPersistence();
    persistence.save('target-a', 1, 'session-1');

    failNextWritePartway();
    persistence.save('target-a', 2, 'session-2');

    expect(new SessionPersistence().load()).toEqual({ 'target-a': { 1: 'session-1' } });
    expect(fs.readdirSync(mockRunnerDir)).toEqual(['broker-sessions.json']);
  });

  it('keeps the saved sessions whole when a removal fails partway', () => {
    const persistence = new SessionPersistence();
    persistence.save('target-a', 1, 'session-1');
    persistence.save('target-a', 2, 'session-2');

    failNextWritePartway();
    persistence.remove('target-a', 1);

    expect(new SessionPersistence().load()).toEqual({ 'target-a': { 1: 'session-1', 2: 'session-2' } });
  });
});
