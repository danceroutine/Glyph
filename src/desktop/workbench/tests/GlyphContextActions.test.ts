import { describe, expect, it } from 'vitest';
import { GlyphContextCandidateKind } from '#src/desktop/workbench/GlyphContextActions.js';

describe('GlyphContextCandidateKind', () => {
  it('distinguishes file, folder, and rule candidates', () => {
    expect({ ...GlyphContextCandidateKind }).toEqual({ FILE: 'file', FOLDER: 'folder', RULE: 'rule' });
  });
});
