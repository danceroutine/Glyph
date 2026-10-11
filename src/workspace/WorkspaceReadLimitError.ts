/** Allows callers to report their own per-file or aggregate budget failure. */
export class WorkspaceReadLimitError extends Error {
  constructor(
    readonly path: string,
    readonly maxBytes: number,
    readonly actualBytes: number,
  ) {
    super(`File exceeds the ${maxBytes}-byte read limit.`);
    this.name = 'WorkspaceReadLimitError';
  }
}
