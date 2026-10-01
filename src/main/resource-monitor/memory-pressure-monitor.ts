/**
 * Host memory pressure, for the Docker VM admission gate.
 *
 * A running VM's memory is committed as the guest touches it and only given
 * back when the VM stops (VZ never returns guest memory), so under pressure
 * the VM manager stops starting what can wait: at warn, no spare VM and no
 * cache refresh; at critical, new boots queue. The kernel's own reading is
 * kern.memorystatus_vm_pressure_level, polled with sysctl off the main
 * thread. See docs/roadmap/vm-docker-backend-contract.md §5.1 and §5.4.
 */

import { execFile } from 'child_process';

export type MemoryPressure = 'normal' | 'warn' | 'critical';

/**
 * How often the level is read. It is read for the app's whole life, on a
 * machine that never runs a Docker job too: the admission gate needs a
 * current level at the moment a boot is asked for, which a monitor started
 * only once VMs run could not give, and one sysctl every 5 s, off the main
 * thread, costs little.
 */
const POLL_MS = 5000;

/**
 * The kernel's level as the VM manager reads it: 1, 2 and 4 are normal, warn
 * and critical. Anything else is warn - an answer this does not understand is
 * no reason to start more VMs, nor to stop the ones running.
 */
export function pressureLevel(raw: string): MemoryPressure {
  switch (raw.trim()) {
    case '1':
      return 'normal';
    case '2':
      return 'warn';
    case '4':
      return 'critical';
    default:
      return 'warn';
  }
}

/** sysctl, asynchronously, with a timeout so a wedged one cannot pile up polls. */
const readSysctl = (): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 2000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
  });

export interface MemoryPressureMonitorOptions {
  /** Called with the new level whenever it changes; the level starts at normal. */
  onChange: (level: MemoryPressure) => void;
  /** Injected for tests; defaults to sysctl. */
  readLevel?: () => Promise<string>;
  log?: (level: 'debug' | 'warn', message: string) => void;
}

export class MemoryPressureMonitor {
  private current: MemoryPressure = 'normal';
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private warnedUnreadable = false;
  private readonly readLevel: () => Promise<string>;

  constructor(private readonly options: MemoryPressureMonitorOptions) {
    this.readLevel = options.readLevel ?? readSysctl;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  level(): MemoryPressure {
    return this.current;
  }

  /**
   * Read the level once, and report it if it changed. A sysctl that fails -
   * there is none off macOS - is said once and read as normal: without a
   * reading the gate still holds VMs to maxRunning.
   */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    let next: MemoryPressure;
    try {
      next = pressureLevel(await this.readLevel());
    } catch (err) {
      if (!this.warnedUnreadable) {
        this.warnedUnreadable = true;
        this.options.log?.('warn', `Cannot read memory pressure; taking it as normal: ${(err as Error).message}`);
      }
      next = 'normal';
    } finally {
      this.polling = false;
    }
    if (next !== this.current) {
      this.current = next;
      this.options.onChange(next);
    }
  }
}
