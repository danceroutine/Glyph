import { describe, expect, it } from 'vitest';
import { GlyphReviewCommand } from '#src/desktop/workbench/GlyphReviewCommand.js';

describe('GlyphReviewCommand', () => {
  it('exposes stable review command identifiers', () => {
    expect({ ...GlyphReviewCommand }).toEqual({
      ADD_TO_CHAT: 'glyph.review.addToChat',
      PREVIOUS_CHANGE: 'glyph.review.previousChange',
      NEXT_CHANGE: 'glyph.review.nextChange',
      PREVIOUS_FILE: 'glyph.review.previousFile',
      NEXT_FILE: 'glyph.review.nextFile',
      KEEP: 'glyph.review.keep',
      UNDO: 'glyph.review.undo',
      COMMENT: 'glyph.review.comment',
      KEEP_FILE: 'glyph.review.keepFile',
      UNDO_FILE: 'glyph.review.undoFile',
      KEEP_ALL: 'glyph.review.keepAll',
    });
  });
});
