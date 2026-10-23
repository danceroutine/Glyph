import { describe, expect, it } from 'vitest';
import { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';
import { GlyphEditorAdapterError } from '#vs/workbench/contrib/glyph/browser/GlyphEditorAdapterError.js';

describe(GlyphEditorAdapterError, () => {
  it('asks for a reload when the workspace changed', () => {
    const error = new GlyphEditorAdapterError(GlyphDesktopErrorCode.WORKSPACE_CHANGED, { reason: 'ignored' });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('GlyphEditorAdapterError');
    expect(error.code).toBe(GlyphDesktopErrorCode.WORKSPACE_CHANGED);
    expect(error.message).toBe(
      'Workspace folders changed. Reload the window to reconnect Glyph before reading or editing files.',
    );
  });

  it('uses a textual reason from its details as the message', () => {
    const details = { reason: 'The file is too large.', size: 12 };
    const error = new GlyphEditorAdapterError(GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED, details);

    expect(error.message).toBe('The file is too large.');
    expect(error.details).toBe(details);
  });

  it('falls back to its code as the message', () => {
    expect(new GlyphEditorAdapterError(GlyphDesktopErrorCode.NOT_FOUND).message).toBe('NOT_FOUND');
    expect(new GlyphEditorAdapterError(GlyphDesktopErrorCode.INTERNAL, { reason: 7 }).message).toBe('INTERNAL');
  });
});
