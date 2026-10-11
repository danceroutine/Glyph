/**
 * Serializes state-changing work per persisted chat and rejects a second window
 * owner. Provider continuation state is ordered, so overlapping sends could
 * otherwise fork or overwrite the same conversation history.
 */
export class ChatOperationSerializer {
  private readonly entries = new Map<string, { ownerWindowId: string; queue: Promise<void> }>();

  /** Chains after either fulfillment or rejection so one failed turn cannot poison the queue. */
  run<T>(key: string, ownerWindowId: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing && existing.ownerWindowId !== ownerWindowId) {
      return Promise.reject(new Error(`Chat ${key} is active in window ${existing.ownerWindowId}.`));
    }
    const entry = existing ?? { ownerWindowId, queue: Promise.resolve() };
    this.entries.set(key, entry);
    const result = entry.queue.then(operation, operation);
    entry.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /** Removes ownership claims after a window disconnects without cancelling already-started work. */
  releaseWindow(windowId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.ownerWindowId === windowId) this.entries.delete(key);
    }
  }
}
