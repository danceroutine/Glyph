import type { GlyphChatSummary } from '#src/desktop/protocol/events/GlyphChatSummary.js';

export const aGlyphChatSummary = (overrides: Partial<GlyphChatSummary> = {}): GlyphChatSummary => ({
  id: 'chat',
  title: 'Chat',
  accountProvider: 'openai',
  accountId: 'account',
  modelSlug: 'gpt-5',
  updatedAt: '2026-01-01T00:00:00.000Z',
  turnCount: 1,
  ...overrides,
});
