import { GlyphError } from '../../errors/GlyphError.ts';
import type { EditFailureReason } from './EditFailureReason.ts';

interface EditErrorDetails {
  source?: string;
  fileId?: string;
  path?: string;
  hunkId?: string;
  currentRevision?: string;
  retry?: string;
  candidates?: number[];
}

export class EditError extends GlyphError {
  constructor(
    readonly reason: EditFailureReason,
    message: string,
    readonly details: EditErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  toJSON(): object {
    return { code: this.reason, message: this.message, ...this.details };
  }
}
