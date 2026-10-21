import { describe, expect, it } from 'vitest';
import { GlyphWorkingCopyPatternKind } from '#src/desktop/protocol/editor/GlyphWorkingCopySearchOptions.js';

describe('GlyphWorkingCopyPatternKind', () => {
  it('distinguishes regular expression and literal search patterns', () => {
    expect({ ...GlyphWorkingCopyPatternKind }).toEqual({
      REGULAR_EXPRESSION: 'regular_expression',
      LITERAL: 'literal',
    });
  });
});
