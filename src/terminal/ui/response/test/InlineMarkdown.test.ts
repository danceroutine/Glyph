import { describe, expect, it } from 'vitest';
import { inlineMarkdownText, parseInlineMarkdown } from '../parseInlineMarkdown.ts';

describe(parseInlineMarkdown, () => {
  it('uses Markdown emphasis rules and preserves nested inline text', () => {
    expect(parseInlineMarkdown('before **bold _and italic_** after __also bold__')).toEqual([
      { value: 'before ', strong: false },
      { value: 'bold and italic', strong: true },
      { value: ' after ', strong: false },
      { value: 'also bold', strong: true },
    ]);
  });

  it('flattens supported inline Markdown without leaking delimiters or destinations', () => {
    const markdown = '~~cut~~ [link](https://example.com) ![alt](image.png) \\*star `**code**` <kbd>x</kbd>  \nnext';

    expect(inlineMarkdownText(markdown)).toBe('cut link alt *star **code** <kbd>x</kbd>\nnext');
  });

  it('returns a plain empty segment for empty input', () => {
    expect(parseInlineMarkdown('')).toEqual([{ value: '', strong: false }]);
    expect(parseInlineMarkdown('![](image.png)')).toEqual([{ value: '', strong: false }]);
  });
});
