/** Queued cancellation releases the caller, never an earlier prompt or grant write. */
export class ApprovalQueue {
  private tail: Promise<void> | undefined;
  constructor(private readonly onIdle: () => void = () => {}) {}
  run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      const start = () => {
        signal.removeEventListener('abort', abort);
        signal.throwIfAborted();
        return operation();
      };
      const predecessor = this.tail;
      let release!: () => void;
      const settled = new Promise<void>(finish => {
        release = finish;
      });
      // Reserve before calling user code: publishing a prompt may reenter run().
      this.tail = settled;
      void settled.then(() => {
        if (this.tail === settled) {
          this.tail = undefined;
          this.onIdle();
        }
      });
      let result: Promise<T>;
      try {
        result = predecessor ? predecessor.then(start) : start();
      } catch (error) {
        result = Promise.reject(error);
      }
      void result.then(
        value => {
          release();
          resolve(value);
        },
        error => {
          release();
          reject(error);
        },
      );
    });
  }
}
