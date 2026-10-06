import { describe, expect, it } from 'vitest';
import { sanitizeText } from '../sanitizeText.ts';

describe(sanitizeText, () => {
  it('removes terminal controls and exposes direction overrides', () => {
    expect(sanitizeText('\u001b[31mred\u001b[0m\u0000\u202e')).toBe('red\\u202e');
  });
});
