import { describe, expect, it } from 'vitest';
import { css } from '#code-oss/ui/design-system/index.ts';

describe(css, () => {
  it('writes generated rules as readable text in a glyph stylesheet', () => {
    const name = css({ outlineOffset: 7 });

    expect(name.startsWith('glyph-')).toBe(true);
    const text = [...document.querySelectorAll('style[data-emotion^="glyph"]')]
      .map(style => style.textContent)
      .join('');
    expect(text).toContain(`.${name}{outline-offset:7px;}`);
  });
});
