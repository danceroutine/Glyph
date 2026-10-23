import { describe, expect, it } from 'vitest';
import { glyphSyntaxStyles } from '#code-oss/ui/GlyphSyntaxHighlighting/GlyphSyntaxStyles.ts';

describe('glyphSyntaxStyles', () => {
  it('is a class name for styling highlighted code', () => {
    expect(glyphSyntaxStyles).toMatch(/^\S+$/u);
  });
});
