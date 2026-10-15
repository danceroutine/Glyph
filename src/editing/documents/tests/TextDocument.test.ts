import { describe, expect, it, vi } from 'vitest';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { TextDocument } from '#src/editing/documents/TextDocument.js';

describe(TextDocument, () => {
  describe(TextDocument.prototype.apply, () => {
    it('indexes immutable source lines once across every endpoint and repeated composition', () => {
      const text = 'x'.repeat(127) + '\n';
      const document = new TextDocument('example.txt', text.repeat(128));
      // Observe the private index builder to enforce a work bound without a
      // machine-dependent timing assertion or production instrumentation.
      const index = vi.spyOn(document as unknown as { lineRanges(): { start: number; end: number }[] }, 'lineRanges');
      const edits = Array.from({ length: 128 }, (_, line) => ({
        range: { start: { line, character: 0 }, end: { line, character: 1 } },
        expected_text: 'x',
        replacement_text: 'y',
      }));
      try {
        const result = document.apply(edits);
        expect(document.apply(edits)).toBe(result);
        expect(index).toHaveBeenCalledTimes(1);
      } finally {
        index.mockRestore();
      }
    });

    it('copies source spans once when composing many replacements', () => {
      const text = ('x'.repeat(127) + '\n').repeat(128);
      const document = new TextDocument('example.txt', text);
      const edits = Array.from({ length: 128 }, (_, line) => ({
        range: { start: { line, character: 0 }, end: { line, character: 1 } },
        expected_text: 'x',
        replacement_text: 'y',
      }));
      const originalSlice = String.prototype.slice;
      let copiedCharacters = 0;
      const slice = vi.spyOn(String.prototype, 'slice').mockImplementation(function (
        this: string,
        start?: number,
        end?: number,
      ) {
        const result = originalSlice.call(this, start, end);
        copiedCharacters += result.length;
        return result;
      });
      let result: string;
      try {
        result = document.apply(edits);
      } finally {
        slice.mockRestore();
      }
      expect(result).toBe(('y' + 'x'.repeat(126) + '\n').repeat(128));
      expect(copiedCharacters).toBeLessThanOrEqual(text.length);
    });

    it.each([-1, 0.5, NaN, Infinity, -Infinity])('rejects invalid character coordinates: %s', character => {
      const document = new TextDocument('example.txt', 'abc');
      expect(() =>
        document.apply([
          {
            range: { start: { line: 0, character }, end: { line: 0, character } },
            expected_text: '',
            replacement_text: 'x',
          },
        ]),
      ).toThrow(expect.objectContaining({ reason: EditFailureReason.INCONSISTENT }));
    });

    it.each([-1, 0.5, NaN, Infinity, -Infinity])('rejects invalid line coordinates: %s', line => {
      const document = new TextDocument('example.txt', 'abc');
      expect(() =>
        document.apply([
          {
            range: { start: { line, character: 0 }, end: { line, character: 0 } },
            expected_text: '',
            replacement_text: 'x',
          },
        ]),
      ).toThrow(expect.objectContaining({ reason: EditFailureReason.INCONSISTENT }));
    });

    it('sorts source ranges while preserving touching insertions and exact line endings', () => {
      const document = new TextDocument('example.txt', '\uFEFFa😀b\r\nsecond\rthird\n');
      expect(
        document.apply([
          {
            range: { start: { line: 2, character: 5 }, end: { line: 3, character: 0 } },
            expected_text: '\n',
            replacement_text: '\r\n',
          },
          {
            range: { start: { line: 0, character: 4 }, end: { line: 0, character: 4 } },
            expected_text: '',
            replacement_text: 'after',
          },
          {
            range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } },
            expected_text: '😀',
            replacement_text: '🧪',
          },
          {
            range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } },
            expected_text: '',
            replacement_text: 'before',
          },
        ]),
      ).toBe('\uFEFFabefore🧪afterb\r\nsecond\rthird\r\n');
    });

    it.each([
      { start: 1, end: 1, expected: '', secondEnd: 1, secondExpected: '', label: 'duplicate insertions' },
      { start: 0, end: 2, expected: 'ab', secondEnd: 2, secondExpected: 'b', label: 'overlapping replacements' },
      { start: 0, end: 3, expected: 'abc', secondEnd: 1, secondExpected: '', label: 'insertions inside replacements' },
    ])('rejects ambiguous $label', ({ start, end, expected, secondEnd, secondExpected }) => {
      const document = new TextDocument('example.txt', 'abc');
      expect(() =>
        document.apply([
          {
            range: { start: { line: 0, character: start }, end: { line: 0, character: end } },
            expected_text: expected,
            replacement_text: 'x',
          },
          {
            range: { start: { line: 0, character: 1 }, end: { line: 0, character: secondEnd } },
            expected_text: secondExpected,
            replacement_text: 'y',
          },
        ]),
      ).toThrow(expect.objectContaining({ reason: EditFailureReason.AMBIGUOUS }));
    });

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
