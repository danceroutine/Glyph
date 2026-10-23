import type { GlyphProposalSummary } from '#src/desktop/protocol/events/GlyphProposalSummary.js';

export const aGlyphProposalSummary = (overrides: Partial<GlyphProposalSummary> = {}): GlyphProposalSummary => ({
  id: 'proposal',
  chatId: 'chat',
  createdAt: '2026-01-01T00:00:00.000Z',
  files: [],
  ...overrides,
});
