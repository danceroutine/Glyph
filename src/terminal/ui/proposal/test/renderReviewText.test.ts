import { expect, it } from 'vitest';
import { renderReviewText } from '#src/terminal/ui/proposal/renderReviewText.js';

it.each([
  ['ANSI escape', '\u001b[31mbody\u001b[0m', '␛[31mbody␛[0m'],
  ['terminal hyperlink', '\u001b]8;;https://example.test\u0007link', '␛]8;;https://example.test␇link'],
  ['backspace and delete', 'a\b\u007fb', 'a␈␡b'],
  ['C1 control', '\u009b31m', '⟨U+009B⟩31m'],
  ['literal text BOM', '\uFEFFbody', '⟨U+FEFF⟩body'],
  ['path newline', 'a\nb', 'a␊b'],
  ['ordinary Unicode and tabs', '😀\ttext', '😀\ttext'],
])('shows %s as safe review evidence instead of deleting it', (_label, value, expected) => {
  expect(renderReviewText(value)).toBe(expected);
});
