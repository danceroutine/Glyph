import type { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';

/** Preserves a typed failure until the transport converts it into a serializable DTO. */
export class GlyphEditorAdapterError extends Error {
  constructor(readonly code: GlyphDesktopErrorCode) {
    super(code);
    this.name = 'GlyphEditorAdapterError';
  }
}
