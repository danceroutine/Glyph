import { describe, expect, it } from 'vitest';
import { GlyphComposerCommand } from '#src/desktop/workbench/GlyphComposerCommand.js';

describe('GlyphComposerCommand', () => {
  it('exposes stable composer command identifiers', () => {
    expect({ ...GlyphComposerCommand }).toEqual({
      SEND: 'glyph.sendMessage',
      STEER: 'glyph.steerMessage',
      INSERT_NEWLINE: 'glyph.insertNewline',
    });
  });
});
