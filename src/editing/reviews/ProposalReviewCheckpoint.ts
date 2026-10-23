/**
 * Coordinates durability across a manager's serialized review operations.
 *
 * A successful workspace mutation cannot be rolled back merely because saving its review state fails. This
 * coordinator retains that obligation until an outcome checkpoint succeeds, so the manager can block the next
 * decision. The supplied writers keep queue snapshots, receipt publication, and settled-review bookkeeping
 * owned by the manager; the executor only selects the required persistence boundary.
 */
export class ProposalReviewCheckpoint {
  private pending = false;

  /** Keeps intent writes separate from outcome writes, which may retire settled reviews after saving them. */
  constructor(
    private readonly writeIntent: () => Promise<void>,
    private readonly writeOutcome: () => Promise<void>,
  ) {}

  /** Exposes the single durability barrier used by both queue admission and execution failure handling. */
  get hasPendingCheckpoint(): boolean {
    return this.pending;
  }

  /** Saves recoverable intent before workspace I/O without treating the operation as durably completed. */
  saveIntent(): Promise<void> {
    return this.writeIntent();
  }

  /** Records confirmed workspace effects synchronously, before result processing or persistence can throw. */
  markWorkspaceChanged(): void {
    this.pending = true;
  }

  /** Preserves the barrier across failures; only a saved outcome permits another queued decision to begin. */
  async saveOutcome(): Promise<void> {
    await this.writeOutcome();
    this.pending = false;
  }

  /** Lets the manager retry outstanding completion before admitting work, without writing on every enqueue. */
  async flushPendingCheckpoint(): Promise<void> {
    if (this.pending) await this.saveOutcome();
  }
}
