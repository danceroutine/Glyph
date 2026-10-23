import { describe, expect, it } from 'vitest';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';

describe('GlyphWorkbenchStatus', () => {
  it('enumerates every sidebar status', () => {
    expect({ ...GlyphWorkbenchStatus }).toEqual({
      READY: 'ready',
      STREAMING: 'streaming',
      DISCONNECTED: 'disconnected',
      WAITING_FOR_QUESTION: 'waiting_for_question',
      WAITING_FOR_APPROVAL: 'waiting_for_approval',
    });
  });
});
