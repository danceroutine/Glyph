import type { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';

/** Local review failures retain their domain and code until presented to the user. */
export class GlyphProposalReviewError extends Error {
  constructor(
    readonly code: GlyphDesktopErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GlyphProposalReviewError';
  }
}
