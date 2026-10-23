import { describe, expect, it } from 'vitest';
import { decisionStyles } from '#code-oss/ui/GlyphDecisionStyles.ts';

describe('decisionStyles', () => {
  it('provides a distinct class name for each part of a decision card', () => {
    const names = Object.values(decisionStyles);

    expect(Object.keys(decisionStyles)).toEqual(['card', 'header', 'actions', 'detail', 'error']);
    expect(names.every(name => /^\S+$/u.test(name))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
});
