/**
 * Shares in-flight and completed results for a renderer request id. This does
 * not make side effects globally exactly-once, but it prevents reconnect/retry
 * traffic from dispatching the same command twice within the bounded session.
 */
export class RequestDeduplicator<T> {
  private readonly results = new Map<string, Promise<T>>();
  private readonly settled = new Set<string>();

  constructor(private readonly capacity = 512) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Request cache capacity must be positive.');
  }

  /** Stores the promise before it settles so concurrent duplicates share failures too. */
  run(requestId: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.results.get(requestId);
    if (existing) return existing;
    if (this.results.size >= this.capacity) {
      const oldest = this.settled.values().next();
      if (oldest.done)
        return Promise.reject(
          new Error('Renderer request capacity is exhausted. Retry after pending requests settle.'),
        );
      this.results.delete(oldest.value);
      this.settled.delete(oldest.value);
    }
    // Reserve the ID before calling user code, including synchronous reentry.
    let succeed!: (value: T) => void;
    let fail!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      succeed = resolve;
      fail = reject;
    });
    this.results.set(requestId, result);
    const reject = (error: unknown) => {
      this.settled.add(requestId);
      fail(error);
    };
    try {
      void operation().then(value => {
        this.settled.add(requestId);
        succeed(value);
      }, reject);
    } catch (error) {
      reject(error);
    }
    return result;
  }
}
