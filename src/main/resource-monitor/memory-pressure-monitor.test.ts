import { describe, it, expect, jest } from '@jest/globals';
import { MemoryPressureMonitor, pressureLevel, MemoryPressure } from './memory-pressure-monitor';

/** A monitor whose sysctl answers from `answers` in turn, polled by hand. */
const monitorWith = (answers: Array<string | Error>) => {
  const changes: MemoryPressure[] = [];
  const logs: string[] = [];
  const readLevel = jest.fn(async () => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next ?? '1';
  });
  const monitor = new MemoryPressureMonitor({
    onChange: (level) => changes.push(level),
    readLevel,
    log: (_level, message) => logs.push(message),
  });
  return { monitor, changes, logs, readLevel };
};

describe('pressureLevel', () => {
  it('reads the kernel levels 1, 2 and 4 as normal, warn and critical', () => {
    expect(pressureLevel('1\n')).toBe('normal');
    expect(pressureLevel('2')).toBe('warn');
    expect(pressureLevel(' 4 ')).toBe('critical');
  });

  it('reads anything else as warn: an answer it does not understand is not a reason to boot more', () => {
    for (const raw of ['0', '3', '8', '', 'high', '1.5', '-1']) {
      expect([raw, pressureLevel(raw)]).toEqual([raw, 'warn']);
    }
  });
});

describe('MemoryPressureMonitor', () => {
  it('reports only changes, starting from normal', async () => {
    const { monitor, changes } = monitorWith(['1', '2', '2', '4', '4', '1', '1']);
    for (let i = 0; i < 7; i++) await monitor.poll();
    expect(changes).toEqual(['warn', 'critical', 'normal']);
    expect(monitor.level()).toBe('normal');
  });

  it('logs a failing sysctl once, and treats it as normal', async () => {
    const { monitor, changes, logs } = monitorWith(['2', new Error('sysctl: unknown oid'), new Error('again'), '1']);
    for (let i = 0; i < 4; i++) await monitor.poll();
    expect(changes).toEqual(['warn', 'normal']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/unknown oid/);
  });

  it('polls every 5 s once started, and not after it is stopped', async () => {
    jest.useFakeTimers();
    try {
      const { monitor, readLevel } = monitorWith([]);
      monitor.start();
      await jest.advanceTimersByTimeAsync(15_000);
      const whileRunning = readLevel.mock.calls.length;
      expect(whileRunning).toBeGreaterThanOrEqual(3);
      monitor.stop();
      await jest.advanceTimersByTimeAsync(15_000);
      expect(readLevel.mock.calls.length).toBe(whileRunning);
    } finally {
      jest.useRealTimers();
    }
  });

  it('asks sysctl by default, off the main thread', async () => {
    // The real sysctl, where there is one: on macOS it answers a level, and
    // elsewhere it fails, which the monitor takes as normal.
    const changes: MemoryPressure[] = [];
    const monitor = new MemoryPressureMonitor({ onChange: (level) => changes.push(level) });
    await monitor.poll();
    const level = monitor.level();
    expect(['normal', 'warn', 'critical']).toContain(level);
    if (process.platform !== 'darwin') expect(level).toBe('normal');
  });
});
