import { HarnessError } from '../../errors/HarnessError.ts';
import type { FileSearchFailureReason } from './FileSearchFailureReason.ts';

/** Typed failure returned by the native file-search protocol or its transport. */
export class FileSearchError extends HarnessError {
  constructor(
    readonly code: FileSearchFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
