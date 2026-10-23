import { describe, expect, it } from 'vitest';
import { GlyphFollowUpBehavior } from '#src/desktop/workbench/GlyphFollowUpBehavior.js';

describe('GlyphFollowUpBehavior', () => {
  it('offers queueing and immediate delivery for follow-up messages', () => {
    expect({ ...GlyphFollowUpBehavior }).toEqual({ QUEUE: 'queue', SEND_IMMEDIATELY: 'sendImmediately' });
  });
});
