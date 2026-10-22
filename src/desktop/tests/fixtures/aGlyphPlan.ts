import type { GlyphPlan } from '#src/desktop/protocol/events/GlyphPlan.js';

export const aGlyphPlan = (overrides: Partial<GlyphPlan> = {}): GlyphPlan => ({
  id: 'plan',
  revision: 1,
  title: 'Plan',
  summary: '',
  markdown: '',
  todos: [],
  agents: [],
  ...overrides,
});
