import { describe, expect, it } from 'vitest';
import { TerminalControlFilter } from '#src/shell/TerminalControlFilter.js';

describe(TerminalControlFilter, () => {
  describe(TerminalControlFilter.prototype.push, () => {
    it.each([
      ['plain text', 'hello', 'hello'],
      ['a seven-bit CSI sequence', 'a\u001B[31mred\u001B[0m', 'ared'],
      ['an eight-bit CSI sequence', 'a\u009B1;2Hb', 'ab'],
      ['an escape with intermediate bytes', 'a\u001B( !Bb', 'ab'],
      ['a two-character escape', 'a\u001Bcb', 'ab'],
      ['an escape followed by a control character', 'a\u001B\u0007b', 'ab'],
      ['an OSC string ended by BEL', 'a\u001B]0;title\u0007b', 'ab'],
      ['a DCS string ended by ESC backslash', 'a\u001BP1$r\u001B\\b', 'ab'],
      ['an escape inside a string that does not end it', 'a\u001B_x\u001Bzy\u009Cb', 'ab'],
      ['a non-OSC string that ignores BEL', 'a\u001BPx\u0007y\u009Cb', 'ab'],
      [
        'eight-bit string introducers',
        'a\u0090x\u009Cb\u0098x\u009Cc\u009Dx\u0007d\u009Ex\u009Ce\u009Fx\u009Cf',
        'abcdef',
      ],
      ['a stray string terminator', 'a\u009Cb', 'ab'],
      ['a cancelled escape sequence', 'a\u001B[12\u0018b', 'ab'],
      ['a substituted string', 'a\u001B]title\u001Ab', 'ab'],
    ])('strips %s', (_case, input, expected) => {
      expect(new TerminalControlFilter().push(input)).toBe(expected);
    });

    it('continues a sequence split across chunks', () => {
      const filter = new TerminalControlFilter();

      expect(filter.push('a\u001B[3')).toBe('a');
      expect(filter.push('1mred')).toBe('red');
      expect(filter.push('\u001B]8;;https://example.test')).toBe('');
      expect(filter.push('\u0007link')).toBe('link');
    });
  });
});
