import { describe, expect, it } from 'vitest';
import { EditFailureReason } from '../../errors/EditFailureReason.ts';
import { TextDocument } from '../TextDocument.ts';

describe(TextDocument, () => {
  describe(TextDocument.prototype.apply, () => {
    it('applies touching edits against immutable UTF-16 source coordinates', () => {
      const document = new TextDocument('example.txt', 'a😀b');

      expect(
        document.apply([
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            expected_text: 'a',
            replacement_text: 'A',
          },
          {
            range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } },
            expected_text: '😀',
            replacement_text: '🧪',
          },
        ]),
      ).toBe('A🧪b');
    });

    it('rejects a position that splits a surrogate pair', () => {
      const document = new TextDocument('example.txt', 'a😀b');

      expect(() =>
        document.apply([
          {
            range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } },
            expected_text: '',
            replacement_text: 'x',
          },
        ]),
      ).toThrow(expect.objectContaining({ reason: EditFailureReason.INCONSISTENT }));
    });
  });
});
