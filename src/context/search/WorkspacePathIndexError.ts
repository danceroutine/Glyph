import { GlyphError } from '../../errors/GlyphError.ts';
import type { WorkspacePathIndexFailureReason } from './WorkspacePathIndexFailureReason.ts';

/** Typed failure returned by the native workspace-path protocol or its transport. */
export class WorkspacePathIndexError extends GlyphError {
  constructor(
    readonly code: WorkspacePathIndexFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
