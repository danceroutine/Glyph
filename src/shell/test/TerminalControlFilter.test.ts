import { describe, expect, it } from 'vitest';
import { TerminalControlFilter } from '#src/shell/TerminalControlFilter.js';

describe(TerminalControlFilter, () => {
  describe(TerminalControlFilter.prototype.push, () => {
    it.each([
      ['plain text', 'hello', 'hello'],
      ['a seven-bit CSI sequence', 'a\x1b[31mred\x1b[0m', 'ared'],
      ['an eight-bit CSI sequence', 'a\x9b1;2Hb', 'ab'],
      ['an escape with intermediate bytes', 'a\x1b( !Bb', 'ab'],
      ['a two-character escape', 'a\x1bcb', 'ab'],
      ['an escape followed by a control character', 'a\x1b\x07b', 'ab'],
      ['an OSC string ended by BEL', 'a\x1b]0;title\x07b', 'ab'],
      ['a DCS string ended by ESC backslash', 'a\x1bP1$r\x1b\\b', 'ab'],
      ['an escape inside a string that does not end it', 'a\x1b_x\x1bzy\x9cb', 'ab'],
      ['a non-OSC string that ignores BEL', 'a\x1bPx\x07y\x9cb', 'ab'],
      ['eight-bit string introducers', 'a\x90x\x9cb\x98x\x9cc\x9dx\x07d\x9ex\x9ce\x9fx\x9cf', 'abcdef'],
      ['a stray string terminator', 'a\x9cb', 'ab'],
      ['a cancelled escape sequence', 'a\x1b[12\x18b', 'ab'],
      ['a substituted string', 'a\x1b]title\x1ab', 'ab'],
    ])('strips %s', (_case, input, expected) => {
      expect(new TerminalControlFilter().push(input)).toBe(expected);
    });

    it('continues a sequence split across chunks', () => {
      const filter = new TerminalControlFilter();

      expect(filter.push('a\x1b[3')).toBe('a');
      expect(filter.push('1mred')).toBe('red');
      expect(filter.push('\x1b]8;;https://example.test')).toBe('');
      expect(filter.push('\x07link')).toBe('link');
    });
  });
});
