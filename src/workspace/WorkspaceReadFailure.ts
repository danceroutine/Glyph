import { WorkspaceReadLimitError } from './WorkspaceReadLimitError.ts';
import { WorkspaceTextDecodingError } from './WorkspaceTextDecodingError.ts';

/** Tracks disk bytes already consumed before a later stage of a catalog read failed. */
export class WorkspaceReadFailure extends Error {
  readonly bytesRead: number;

  constructor(cause: unknown, completedBytes: number) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.bytesRead = completedBytes + workspaceReadFailureBytes(cause);
  }
}

export function workspaceReadFailureBytes(error: unknown): number {
  return error instanceof WorkspaceReadFailure ||
    error instanceof WorkspaceReadLimitError ||
    error instanceof WorkspaceTextDecodingError
    ? error.bytesRead
    : 0;
}
