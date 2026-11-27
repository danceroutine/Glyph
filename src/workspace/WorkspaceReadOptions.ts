/** Bounds bytes before an adapter allocates, decodes, hashes, or transfers file contents. */
export interface WorkspaceReadOptions {
  readonly maxBytes?: number;
  /** A durable filesystem rename checkpoint may verify the exact two-link inode and already-reviewed bytes. */
  readonly interruptedRename?: { readonly identity: string; readonly revision: string };
}
