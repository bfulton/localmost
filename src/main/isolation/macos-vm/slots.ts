/**
 * The two macOS VM slots, as Electron hands them out: to job VMs and to the
 * golden image's build alike, first come first served, never more at once
 * than this Mac's limit (host.ts: two, or one when memory allows only one).
 *
 * The helper holds a flock on its slot's lock file for its life, so even a
 * mistake here cannot start a third macOS VM; this queue is what makes a
 * job wait for a slot rather than fail on that lock. A slot also names the
 * machine identity its VM presents, so a caller may ask for one slot in
 * particular (save-state does), or for any of those it can use.
 */

export type SlotNumber = 1 | 2;

interface Waiter {
  allowed: readonly SlotNumber[];
  owner: string;
  resolve: (slot: SlotNumber) => void;
  reject: (err: Error) => void;
}

export class MacVmSlots {
  private readonly held = new Map<SlotNumber, string>();
  private readonly waiting: Waiter[] = [];

  /** `limit` is read at each grant: how many macOS VMs may run at once now. */
  constructor(private readonly limit: () => number) {}

  /**
   * A free slot among `allowed`, once one is free and the limit allows
   * another VM. Waits in order of asking; an abort rejects and leaves the
   * queue.
   */
  acquire(owner: string, allowed: readonly SlotNumber[] = [1, 2], signal?: AbortSignal): Promise<SlotNumber> {
    if (allowed.length === 0) return Promise.reject(new Error('no macOS VM slot can be used'));
    if (signal?.aborted) return Promise.reject(new Error('cancelled while waiting for a macOS VM slot'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { allowed, owner, resolve, reject };
      this.waiting.push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.waiting.indexOf(waiter);
          if (i !== -1) {
            this.waiting.splice(i, 1);
            reject(new Error('cancelled while waiting for a macOS VM slot'));
            this.grant();
          }
        },
        { once: true }
      );
      this.grant();
    });
  }

  release(slot: SlotNumber): void {
    this.held.delete(slot);
    this.grant();
  }

  /** Who holds which slot, for the setup page and the logs. */
  holders(): Array<{ slot: SlotNumber; owner: string }> {
    return [...this.held].map(([slot, owner]) => ({ slot, owner }));
  }

  /** How many are waiting. */
  queued(): number {
    return this.waiting.length;
  }

  private grant(): void {
    // In order; a waiter that cannot be served yet does not hold up one
    // behind it that can (a save-state for slot 2 behind a job in slot 2).
    for (let i = 0; i < this.waiting.length; ) {
      if (this.held.size >= this.limit()) return;
      const w = this.waiting[i];
      const slot = w.allowed.find((s) => !this.held.has(s));
      if (slot === undefined) {
        i++;
        continue;
      }
      this.waiting.splice(i, 1);
      this.held.set(slot, w.owner);
      w.resolve(slot);
    }
  }
}
