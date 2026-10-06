import { HarnessError } from '../../errors/HarnessError.ts';
import type { ContextAttachmentFailureReason } from './ContextAttachmentFailureReason.ts';

interface ContextAttachmentErrorDetails {
  readonly path?: string;
  readonly limit?: number;
  readonly actual?: number;
}

/** Typed failure raised while validating or resolving prompt attachments. */
export class ContextAttachmentError extends HarnessError {
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
