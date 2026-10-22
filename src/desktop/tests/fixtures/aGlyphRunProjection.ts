import { GlyphRunStatus, type GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';

export const aGlyphRunProjection = (overrides: Partial<GlyphRunProjection> = {}): GlyphRunProjection => ({
  chatId: 'chat',
  runId: 'run',
  status: GlyphRunStatus.COMPLETED,
  text: '',
  reasoning: '',
  tools: [],
  ...overrides,
});
