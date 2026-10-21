import { describe, expect, it } from 'vitest';
import { toToolActivityPreview } from '#src/chat/toToolActivityPreview.js';

describe(toToolActivityPreview, () => {
  it('keeps output up to sixteen thousand characters unchanged', () => {
    const output = 'x'.repeat(16_000);

    expect(toToolActivityPreview(output)).toBe(output);
  });

  it('truncates longer output with a marker', () => {
    expect(toToolActivityPreview(`${'x'.repeat(16_000)}tail`)).toBe(`${'x'.repeat(16_000)}\n… (truncated)`);
  });
});
