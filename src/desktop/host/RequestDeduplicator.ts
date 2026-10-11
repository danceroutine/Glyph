/**
 * Shares in-flight and completed results for a renderer request id. This does
 * not make side effects globally exactly-once, but it prevents reconnect/retry
 * traffic from dispatching the same command twice within the bounded session.
 */
export class RequestDeduplicator<T> {
  private readonly results = new Map<string, Promise<T>>();

  constructor(private readonly capacity = 512) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Request cache capacity must be positive.');
  }

  /** Stores the promise before it settles so concurrent duplicates share failures too. */
  run(requestId: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.results.get(requestId);
    if (existing) return existing;
    const result = operation();
    this.results.set(requestId, result);
    if (this.results.size > this.capacity) this.results.delete(this.results.keys().next().value!);
    return result;
  }
}
