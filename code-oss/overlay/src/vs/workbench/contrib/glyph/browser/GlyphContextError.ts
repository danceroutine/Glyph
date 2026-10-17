import type { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';

export class GlyphContextError extends Error {
  constructor(
    readonly code: GlyphDesktopErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GlyphContextError';
  }
}
