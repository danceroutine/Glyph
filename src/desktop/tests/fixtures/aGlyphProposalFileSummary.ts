import {
  GlyphProposalApplicability,
  type GlyphProposalFileSummary,
} from '#src/desktop/protocol/events/GlyphProposalFileSummary.js';

export const aGlyphProposalFileSummary = (
  overrides: Partial<GlyphProposalFileSummary> = {},
): GlyphProposalFileSummary => ({
  id: 'file',
  path: 'src/app.ts',
  proposedUri: 'glyph://proposal/file',
  pendingItemIds: ['item'],
  applicability: GlyphProposalApplicability.READY,
  ...overrides,
});
