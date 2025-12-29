/**
 * Message Queue
 *
 * Manages per-target message queues for the broker proxy.
 * Handles message deduplication and target-specific queuing.
 */

import { getLogger } from '../app-state';

const log = () => getLogger();

/**
 * Manages message queues for broker proxy targets.
 */
export class MessageQueue {
  private queues: Map<string, string[]> = new Map();
  private seenMessageIds: Set<string> = new Set();

  /** Maximum number of message IDs to track for deduplication */
  private static readonly MAX_SEEN_IDS = 10000;

  /**
   * Check if we've already seen a message ID (for deduplication).
   */
  hasSeenMessage(messageId: string): boolean {
    return this.seenMessageIds.has(messageId);
  }

  /**
   * Mark a message ID as seen.
   */
  markMessageSeen(messageId: string): void {
    this.seenMessageIds.add(messageId);

    // Prevent unbounded growth
    if (this.seenMessageIds.size > MessageQueue.MAX_SEEN_IDS) {
      const toRemove = Array.from(this.seenMessageIds).slice(0, 1000);
      toRemove.forEach(id => this.seenMessageIds.delete(id));
      log()?.debug(`[MessageQueue] Pruned ${toRemove.length} old message IDs`);
    }
  }

  /**
   * Enqueue a message for a target.
   */
  enqueue(targetId: string, message: string): void {
    if (!this.queues.has(targetId)) {
      this.queues.set(targetId, []);
    }
    this.queues.get(targetId)!.push(message);
  }

  /**
   * Dequeue the next message for a target.
   * Returns undefined if no messages are available.
   */
  dequeue(targetId: string): string | undefined {
    const queue = this.queues.get(targetId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    return queue.shift();
  }

  /**
   * Peek at the next message without removing it.
   */
  peek(targetId: string): string | undefined {
    const queue = this.queues.get(targetId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    return queue[0];
  }

  /**
   * Get the number of messages queued for a target.
   */
  getQueueLength(targetId: string): number {
    return this.queues.get(targetId)?.length ?? 0;
  }

  /**
   * Check if there are any messages for a target.
   */
  hasMessages(targetId: string): boolean {
    return this.getQueueLength(targetId) > 0;
  }

  /**
   * Clear all messages for a target.
   */
  clearTarget(targetId: string): void {
    this.queues.delete(targetId);
  }

  /**
   * Clear all queues.
   */
  clearAll(): void {
    this.queues.clear();
    this.seenMessageIds.clear();
  }

  /**
   * Get all target IDs with queued messages.
   */
  getTargetsWithMessages(): string[] {
    return Array.from(this.queues.keys()).filter(id => this.hasMessages(id));
  }
}
