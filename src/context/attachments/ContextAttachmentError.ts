import { GlyphError } from '../../errors/GlyphError.ts';
import type { ContextAttachmentFailureReason } from './ContextAttachmentFailureReason.ts';

interface ContextAttachmentErrorDetails {
  readonly path?: string;
  readonly limit?: number;
  readonly actual?: number;
}

/** Typed failure raised while validating or resolving prompt attachments. */
export class ContextAttachmentError extends GlyphError {
  constructor(
    readonly reason: ContextAttachmentFailureReason,
    message: string,
    readonly details: ContextAttachmentErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  toJSON(): object {
    return { code: this.reason, message: this.message, ...this.details };
  }
}
