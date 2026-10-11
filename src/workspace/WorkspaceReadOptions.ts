/** Bounds bytes before an adapter allocates, decodes, hashes, or transfers file contents. */
export interface WorkspaceReadOptions {
  readonly maxBytes?: number;
}
