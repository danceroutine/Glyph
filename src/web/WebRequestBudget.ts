/** One cumulative network deadline; human consent pauses it, caller cancellation never does. */
export class WebRequestBudget {
  readonly signal: AbortSignal;
  private readonly timeout = new AbortController();
  private timer: ReturnType<typeof setTimeout>;
  private startedAt = Date.now();
  constructor(
    private remaining: number,
    cancellation: AbortSignal,
  ) {
    this.signal = AbortSignal.any([cancellation, this.timeout.signal]);
    this.timer = this.start();
  }
  async awaitConsent(operation: () => Promise<void>): Promise<void> {
    this.signal.throwIfAborted();
    this.remaining -= Date.now() - this.startedAt;
    clearTimeout(this.timer);
    try {
      await operation();
    } finally {
      this.startedAt = Date.now();
      this.timer = this.start();
    }
  }
  close(): void {
    clearTimeout(this.timer);
  }
  private start(): ReturnType<typeof setTimeout> {
    return setTimeout(
      () => {
        this.timeout.abort(new Error('Network deadline exceeded.'));
      },
      Math.max(0, this.remaining),
    );
  }
}
