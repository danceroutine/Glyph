import { GlyphWorkbenchStatus, type GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';

export const aGlyphWorkbenchState = (overrides: Partial<GlyphWorkbenchState> = {}): GlyphWorkbenchState => ({
  status: GlyphWorkbenchStatus.READY,
  transcript: [],
  usage: {},
  accounts: [],
  models: [],
  chats: [],
  runs: [],
  proposals: [],
  ownerWindowId: 'window',
  readOnly: false,
  sequence: 0,
  ...overrides,
});
