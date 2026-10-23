import type { GlyphPlanRecord } from '#src/desktop/protocol/events/GlyphPlanRecord.js';

export const aGlyphPlan = (overrides: Partial<GlyphPlanRecord> = {}): GlyphPlanRecord => ({
  id: 'plan',
  revision: 1,
  title: 'Plan',
  summary: '',
  markdown: '',
  todos: [],
  agents: [],
  ...overrides,
});
