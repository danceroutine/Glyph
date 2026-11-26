/** An explicitly classified domain failure. Unknown exceptions keep the executor's conservative redaction policy. */
export class ToolOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcome: 'not_started' | 'unknown',
    readonly output?: string,
  ) {
    super(message);
    this.name = 'ToolOperationError';
  }
}
