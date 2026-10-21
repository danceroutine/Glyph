import { describe, expect, it } from 'vitest';
import { GlyphContextCandidateKind } from '#src/desktop/workbench/GlyphContextActions.js';

describe('GlyphContextCandidateKind', () => {
  it('distinguishes file and folder candidates', () => {
    expect({ ...GlyphContextCandidateKind }).toEqual({ FILE: 'file', FOLDER: 'folder' });
  });
});
