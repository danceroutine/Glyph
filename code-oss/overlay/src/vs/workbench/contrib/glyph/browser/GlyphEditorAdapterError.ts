import { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';

/** Preserves a typed failure until the transport converts it into a serializable DTO. */
export class GlyphEditorAdapterError extends Error {
  constructor(
    readonly code: GlyphDesktopErrorCode,
    readonly details?: Readonly<Record<string, string | number>>,
  ) {
    super(
      code === GlyphDesktopErrorCode.WORKSPACE_CHANGED
        ? 'Workspace folders changed. Reload the window to reconnect Glyph before reading or editing files.'
        : typeof details?.reason === 'string'
          ? details.reason
          : code,
    );
    this.name = 'GlyphEditorAdapterError';
  }
}
