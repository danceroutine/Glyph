/** Bounds bytes before an adapter allocates, decodes, hashes, or transfers file contents. */
export interface WorkspaceReadOptions {
  /** Composed reads retain the source root and reservations through delivery. */
  readonly retainAccess?: (check: () => void) => void;
  readonly maxBytes?: number;
  /** Remaining physical I/O allowance for an operation that verifies a snapshot with multiple disk reads. */
  readonly physicalByteBudget?: number;
  /** A durable filesystem rename checkpoint may verify the exact two-link inode and already-reviewed bytes. */
  readonly interruptedRename?: { readonly identity: string; readonly revision: string };
}
