import { describe, expect, it } from 'vitest';
import { inlineMarkdownText, parseInlineMarkdown } from '#src/terminal/ui/response/parseInlineMarkdown.js';

describe(parseInlineMarkdown, () => {
  it('decodes text entities once while preserving code, escaped text, and autolinks', () => {
    expect(inlineMarkdownText('**A &amp; B** &lt;Widget&gt; &copy; &#38;amp; &amp;amp;')).toBe(
      'A & B <Widget> © &amp; &amp;',
    );
    expect(inlineMarkdownText('![A &amp; B](image.png) [C &amp; D](https://example.com)')).toBe('A & B C & D');
    expect(inlineMarkdownText('`&amp; &#38;` \\&amp; <https://example.com/?a=1&amp;b=2>')).toBe(
      '&amp; &#38; &amp; https://example.com/?a=1&amp;b=2',
    );
    expect(inlineMarkdownText('<code>&amp;</code>')).toBe('<code>&amp;</code>');
  });

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
