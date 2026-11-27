import { EditError } from '#src/editing/errors/EditError.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';

/** Counts authorized file bytes already loaded before lossless text decoding failed. */
export class WorkspaceTextDecodingError extends EditError {
  constructor(
    path: string,
    message: string,
    readonly bytesRead: number,
    options?: ErrorOptions,
  ) {
    super(EditFailureReason.UNSUPPORTED, message, { path }, options);
  }
}
