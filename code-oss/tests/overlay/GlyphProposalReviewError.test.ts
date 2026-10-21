import { describe, expect, it } from 'vitest';
import { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';
import { GlyphProposalReviewError } from '#vs/workbench/contrib/glyph/browser/GlyphProposalReviewError.js';

describe(GlyphProposalReviewError, () => {
  it('retains its code, message and cause', () => {
    const cause = new Error('disk full');
    const error = new GlyphProposalReviewError(GlyphDesktopErrorCode.CHAT_BUSY, 'Still saving.', { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('GlyphProposalReviewError');
    expect(error.code).toBe(GlyphDesktopErrorCode.CHAT_BUSY);
    expect(error.message).toBe('Still saving.');
    expect(error.cause).toBe(cause);
  });
});
