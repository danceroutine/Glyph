import { describe, expect, it } from 'vitest';
import { GlyphAgentReviewScope, glyphAgentReviewLabels } from '#src/desktop/workbench/GlyphAgentReview.js';

describe('glyphAgentReviewLabels', () => {
  it('labels every review scope for display', () => {
    expect(glyphAgentReviewLabels).toEqual({
      [GlyphAgentReviewScope.LAST_COMMIT]: 'Last commit',
      [GlyphAgentReviewScope.STAGED]: 'Staged changes',
      [GlyphAgentReviewScope.ALL_LOCAL]: 'All local changes',
      [GlyphAgentReviewScope.BRANCH]: 'Compare against branch',
    });
  });
});
