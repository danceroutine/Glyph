import { diffChars } from 'diff';
import { describe, expect, it } from 'vitest';
import { transformTextEditRanges, type TextEditRange, type TransformedTextEditRange } from '../TextEditTransformer.ts';

describe('TextEditTransformer adversarial behavior', () => {
  describe('ambiguous and repeated text', () => {
    it('maps a uniquely marked range through a large ambiguous repeated prefix', () => {
      const repeated = 'ab'.repeat(2_048);
      const previous = `${repeated}<target>editable</target>${repeated}`;
      const current = `${'ab'.repeat(1_023)}INSERTED${'ab'.repeat(1_025)}<target>editable</target>${repeated}`;
      const sourceStart = previous.indexOf('editable');

      expect(transformTextEditRanges(previous, current, [textRange(previous, sourceStart, 'editable')])).toEqual([
        {
          sourceStart: current.indexOf('editable'),
          sourceEnd: current.indexOf('editable') + 'editable'.length,
        },
      ]);
    });

    it('retains exact fallback semantics when repeated blocks make deletion identity unknowable', () => {
      const previous = 'block|block|block';
      const current = 'block|block';
      const ranges = [
        textRange(previous, 0, 'block'),
        textRange(previous, 6, 'block'),
        textRange(previous, 12, 'block'),
      ];

      for (const range of ranges) {
        expect(transformTextEditRanges(previous, current, [range])).toEqual(exactTransform(previous, current, [range]));
      }
    });

    it('does not mistake one repeated occurrence for another after a distant length-changing edit', () => {
      const previous = 'same/left/same/middle/same/right/same';
      const current = 'same/left-was-expanded/same/middle/same/right/same';
      const sourceStart = previous.lastIndexOf('same');

      expect(transformTextEditRanges(previous, current, [textRange(previous, sourceStart, 'same')])).toEqual([
        {
          sourceStart: current.lastIndexOf('same'),
          sourceEnd: current.lastIndexOf('same') + 'same'.length,
        },
      ]);
    });

    it('uses the compatible snapshot interpretation when edit-operation history is unavailable', () => {
      // These snapshots could come from replacing the whole string, which would
      // conflict, or from replacing only `a` and `c`, which would not. A snapshot
      // transformer cannot distinguish those histories and follows the exact
      // character diff, which preserves the unchanged middle character.
      expect(transformTextEditRanges('abc', 'XbY', [{ sourceStart: 1, sourceEnd: 2, removedText: 'b' }])).toEqual([
        { sourceStart: 1, sourceEnd: 2 },
      ]);
    });
  });

  describe('UTF-16 and newline coordinates', () => {
    it('maps complete surrogate pairs, combining sequences, and zero-width-joiner emoji by UTF-16 offsets', () => {
      const previous =
        'start\r\n\ud83e\uddea lab\r\n\ud83d\udc69\u200d\ud83d\udcbb code\r\ne\u0301 accent\r\n\ud834\udd1e music\r\nend\r\n';
      const current =
        'start\r\n\ud83c\udf0d\ud83c\udf0e planets\r\n\ud83e\uddea lab\r\n\ud83d\udc69\u200d\ud83d\udcbb code expanded\r\ne\u0301 accent\r\n\ud834\udd1e music\r\nend\r\n';
      const targets = ['\ud83e\uddea', 'e\u0301', '\ud834\udd1e'].map(value => {
        const sourceStart = previous.indexOf(value);
        return textRange(previous, sourceStart, value);
      });

      expect(transformTextEditRanges(previous, current, targets)).toEqual(
        targets.map(({ removedText }) => {
          const sourceStart = current.indexOf(removedText);
          return { sourceStart, sourceEnd: sourceStart + removedText.length };
        }),
      );
    });

    it('preserves CRLF ranges when edits before and after use different newline spellings', () => {
      const previous = 'alpha\r\nbeta\r\ngamma\r\ndelta\r\n';
      const current = 'heading\ngoes\nhere\nalpha\r\nbeta\r\ngamma\r\ndelta\r\nfooter\r';
      const sourceStart = previous.indexOf('beta\r\ngamma');
      const expectedStart = current.indexOf('beta\r\ngamma');

      expect(transformTextEditRanges(previous, current, [textRange(previous, sourceStart, 'beta\r\ngamma')])).toEqual([
        { sourceStart: expectedStart, sourceEnd: expectedStart + 'beta\r\ngamma'.length },
      ]);
    });

    it('rejects a range whose expected text differs only in newline encoding', () => {
      expect(
        transformTextEditRanges('alpha\r\nbeta\r\n', 'prefix\nalpha\r\nbeta\r\n', [
          { sourceStart: 0, sourceEnd: 10, removedText: 'alpha\nbeta' },
        ]),
      ).toBeUndefined();
    });
  });

  describe('boundary affinity', () => {
    it.each([
      ['insert at replacement start', 'abcdef', 'abXcdef', 2, 4, 'cd', 3, 5],
      ['insert at replacement end', 'abcdef', 'abcdXef', 2, 4, 'cd', 2, 4],
      ['delete immediately before replacement', 'abcdef', 'acdef', 2, 4, 'cd', 1, 3],
      ['delete immediately after replacement', 'abcdef', 'abcdf', 2, 4, 'cd', 2, 4],
      ['replace immediately before replacement', 'abcdef', 'LONGcdef', 2, 4, 'cd', 4, 6],
      ['replace immediately after replacement', 'abcdef', 'abcdLONG', 2, 4, 'cd', 2, 4],
    ] as const)('%s', (_name, previous, current, start, end, removedText, expectedStart, expectedEnd) => {
      expect(transformTextEditRanges(previous, current, [{ sourceStart: start, sourceEnd: end, removedText }])).toEqual(
        [{ sourceStart: expectedStart, sourceEnd: expectedEnd }],
      );
    });

    it.each([
      ['same-offset insertion', 'abcdef', 'abXcdef', 2],
      ['deletion swallowing insertion point', 'abcdef', 'abef', 3],
      ['replacement swallowing insertion point', 'abcdef', 'abZZef', 3],
    ] as const)('rejects %s for a proposal insertion', (_name, previous, current, offset) => {
      expect(
        transformTextEditRanges(previous, current, [{ sourceStart: offset, sourceEnd: offset, removedText: '' }]),
      ).toBeUndefined();
    });

    it.each([
      ['deletion ending at insertion point', 'abcdef', 'acdef', 2, 1],
      ['deletion starting at insertion point', 'abcdef', 'abcef', 3, 3],
      ['replacement ending at insertion point', 'abcdef', 'aLONGcdef', 2, 5],
      ['replacement starting at insertion point', 'abcdef', 'abLONGdef', 2, 2],
    ] as const)('keeps deterministic affinity for %s', (_name, previous, current, offset, expectedOffset) => {
      expect(
        transformTextEditRanges(previous, current, [{ sourceStart: offset, sourceEnd: offset, removedText: '' }]),
      ).toEqual([{ sourceStart: expectedOffset, sourceEnd: expectedOffset }]);
    });
  });

  describe('batch and ordering invariants', () => {
    it('preserves caller order and maps an unsorted batch exactly as independent transforms', () => {
      const previous = numberedDocument(40);
      const current = replaceAllAtOnce(previous, [
        ['human-003', 'human-003-expanded'],
        ['human-019', 'H'],
        ['human-031', 'human-031-expanded-even-more'],
      ]);
      const ranges = [33, 2, 28, 7, 14].map(index => rangeForValue(previous, `agent-${pad(index)}`));
      const individually = ranges.map(range => transformTextEditRanges(previous, current, [range])?.[0]);

      expect(transformTextEditRanges(previous, current, ranges)).toEqual(individually);
    });

    it('fails a mixed batch atomically while unaffected ranges remain independently transformable', () => {
      const previous = numberedDocument(12);
      const current = previous.replace('agent-005', 'human-overlap-005').replace('human-009', 'human-009-expanded');
      const safe = rangeForValue(previous, 'agent-002');
      const conflicted = rangeForValue(previous, 'agent-005');
      const alsoSafe = rangeForValue(previous, 'agent-010');

      expect(transformTextEditRanges(previous, current, [safe, conflicted, alsoSafe])).toBeUndefined();
      expect(transformTextEditRanges(previous, current, [safe])).toEqual(exactTransform(previous, current, [safe]));
      expect(transformTextEditRanges(previous, current, [alsoSafe])).toEqual(
        exactTransform(previous, current, [alsoSafe]),
      );
    });

    it('is invariant under range permutation', () => {
      const previous = numberedDocument(24);
      const current = previous.replace('human-004', 'four').replace('human-020', 'twenty-expanded');
      const ranges = [1, 8, 12, 17, 23].map(index => rangeForValue(previous, `agent-${pad(index)}`));
      const reversed = [...ranges].reverse();

      expect(transformTextEditRanges(previous, current, reversed)).toEqual(
        [...(transformTextEditRanges(previous, current, ranges) ?? [])].reverse(),
      );
    });

    it('composes across multiple compatible document revisions', () => {
      const previous = numberedDocument(32);
      const middle = previous.replace('human-003', 'first-stage-expanded').replace('human-027', 'x');
      const current = middle.replace('human-010', 'second-stage').replace('human-019', 'second-stage-expanded');
      const originalRanges = [1, 8, 16, 24, 30].map(index => rangeForValue(previous, `agent-${pad(index)}`));
      const middleRanges = transformTextEditRanges(previous, middle, originalRanges);
      expect(middleRanges).toBeDefined();
      const rangesFromMiddle = middleRanges!.map(({ sourceStart, sourceEnd }, index) => ({
        sourceStart,
        sourceEnd,
        removedText: originalRanges[index]!.removedText,
      }));

      expect(transformTextEditRanges(middle, current, rangesFromMiddle)).toEqual(
        transformTextEditRanges(previous, current, originalRanges),
      );
    });

    it('is invariant when the same astral prefix and suffix are added to both revisions', () => {
      const previous = numberedDocument(16);
      const current = previous.replace('human-004', 'short').replace('human-013', 'substantially-longer');
      const ranges = [2, 8, 15].map(index => rangeForValue(previous, `agent-${pad(index)}`));
      const result = transformTextEditRanges(previous, current, ranges);
      const prefix = '\ud83e\uddea\ud83e\uddea shared prefix\r\n';
      const suffix = '\r\nshared suffix \ud83d\ude80';
      const shiftedRanges = ranges.map(range => ({
        ...range,
        sourceStart: range.sourceStart + prefix.length,
        sourceEnd: range.sourceEnd + prefix.length,
      }));

      expect(transformTextEditRanges(prefix + previous + suffix, prefix + current + suffix, shiftedRanges)).toEqual(
        result?.map(range => ({
          sourceStart: range.sourceStart + prefix.length,
          sourceEnd: range.sourceEnd + prefix.length,
        })),
      );
    });
  });

  describe('exact-oracle equivalence under heavy sparse edits', () => {
    it('maps known-compatible edits across seeded repeated-alphabet documents', () => {
      const random = randomNumbers(0xa11b1a05);
      for (let iteration = 0; iteration < 1_000; iteration++) {
        const previous = randomText(96, random, 'abc');
        const sourceStart = Math.floor(random() * (previous.length + 1));
        const sourceEnd = sourceStart + Math.floor(random() * (Math.min(8, previous.length - sourceStart) + 1));
        const proposal: TextEditRange = {
          sourceStart,
          sourceEnd,
          removedText: previous.slice(sourceStart, sourceEnd),
        };
        const humanStart = Math.floor(random() * (previous.length + 1));
        const humanEnd = humanStart + Math.floor(random() * (Math.min(8, previous.length - humanStart) + 1));
        const insertedText = randomText(Math.floor(random() * 9), random, 'abcXYZ');
        const current = previous.slice(0, humanStart) + insertedText + previous.slice(humanEnd);

        const interveningEdit = {
          sourceStart: humanStart,
          sourceEnd: humanEnd,
          insertedLength: insertedText.length,
        };
        if (editsConflict(proposal, interveningEdit) || distanceBetween(proposal, interveningEdit) < 32) continue;
        expect(
          transformTextEditRanges(previous, current, [proposal]),
          `seeded iteration ${iteration}: ${JSON.stringify({ previous, current, proposal, humanStart, humanEnd, insertedText })}`,
        ).toEqual(transformWithKnownEdits(current, [proposal], [interveningEdit]));
      }
    });

    it('matches an unbounded character-diff oracle for many ranges and many intervening edits', () => {
      const previous = numberedDocument(512);
      const targets = Array.from({ length: 96 }, (_, position) => (position * 5 + 1) % 512);
      const targetSet = new Set(targets);
      const humanIndexes = Array.from({ length: 128 }, (_, position) => (position * 4 + 2) % 512).filter(
        index => !targetSet.has(index),
      );
      const replacements = humanIndexes.map(
        index =>
          [
            `human-${pad(index)}`,
            index % 3 === 0 ? `H-${index}` : `human-expanded-${index}-${'x'.repeat(index % 17)}`,
          ] as const,
      );
      const current = replaceAllAtOnce(previous, replacements);
      const ranges = targets.map(index => rangeForValue(previous, `agent-${pad(index)}`)).reverse();

      expect(transformTextEditRanges(previous, current, ranges)).toEqual(exactTransform(previous, current, ranges));
    });

    it('matches the exact oracle across seeded batches of insertions, deletions, and replacements', () => {
      const random = randomNumbers(0x5ea1ed);
      for (let iteration = 0; iteration < 100; iteration++) {
        const previous = numberedDocument(48);
        const targetIndexes = shuffledIndexes(48, random).slice(0, 8);
        const targetSet = new Set(targetIndexes);
        const humanIndexes = shuffledIndexes(48, random)
          .filter(index => !targetSet.has(index))
          .slice(0, 10);
        const replacements = humanIndexes.map((index, replacementIndex) => {
          const original = `human-${pad(index)}`;
          switch ((iteration + replacementIndex) % 3) {
            case 0:
              return [original, ''] as const;
            case 1:
              return [original, `H${iteration}-${replacementIndex}`] as const;
            default:
              return [original, `before-${original}-after-${'x'.repeat(replacementIndex)}`] as const;
          }
        });
        const current = replaceAllAtOnce(previous, replacements);
        const ranges = targetIndexes.map(index => rangeForValue(previous, `agent-${pad(index)}`));

        expect(transformTextEditRanges(previous, current, ranges), `seeded iteration ${iteration}`).toEqual(
          exactTransform(previous, current, ranges),
        );
      }
    });
  });
});

function textRange(text: string, sourceStart: number, removedText: string): TextEditRange {
  return { sourceStart, sourceEnd: sourceStart + removedText.length, removedText };
}

function rangeForValue(text: string, value: string): TextEditRange {
  const sourceStart = text.indexOf(value);
  if (sourceStart < 0) throw new Error(`Missing test value: ${value}`);
  return textRange(text, sourceStart, value);
}

function numberedDocument(lines: number): string {
  return Array.from(
    { length: lines },
    (_, index) => `record-${pad(index)}|agent-${pad(index)}|human-${pad(index)}|context-${pad(index)}\r\n`,
  ).join('');
}

function pad(value: number): string {
  return value.toString().padStart(3, '0');
}

function replaceAllAtOnce(text: string, replacements: readonly (readonly [string, string])[]): string {
  const located = replacements
    .map(([removedText, insertedText]) => {
      const sourceStart = text.indexOf(removedText);
      if (sourceStart < 0) throw new Error(`Missing replacement value: ${removedText}`);
      return { sourceStart, sourceEnd: sourceStart + removedText.length, insertedText };
    })
    .sort((left, right) => right.sourceStart - left.sourceStart);
  let result = text;
  for (const replacement of located) {
    result = result.slice(0, replacement.sourceStart) + replacement.insertedText + result.slice(replacement.sourceEnd);
  }
  return result;
}

function exactTransform(
  previousText: string,
  currentText: string,
  ranges: readonly TextEditRange[],
): readonly TransformedTextEditRange[] | undefined {
  const changes = diffChars(previousText, currentText);
  const edits: { sourceStart: number; sourceEnd: number; insertedLength: number }[] = [];
  let sourceOffset = 0;
  for (let index = 0; index < changes.length;) {
    const change = changes[index]!;
    if (!change.added && !change.removed) {
      sourceOffset += change.value.length;
      index++;
      continue;
    }
    const sourceStart = sourceOffset;
    let insertedLength = 0;
    while (index < changes.length) {
      const part = changes[index]!;
      if (!part.added && !part.removed) break;
      if (part.removed) sourceOffset += part.value.length;
      if (part.added) insertedLength += part.value.length;
      index++;
    }
    edits.push({ sourceStart, sourceEnd: sourceOffset, insertedLength });
  }

  const transformed: TransformedTextEditRange[] = [];
  for (const range of ranges) {
    if (edits.some(edit => editsConflict(range, edit))) return undefined;
    const sourceStart = transformBoundary(range.sourceStart, 'start', edits);
    const sourceEnd = transformBoundary(range.sourceEnd, 'end', edits);
    if (currentText.slice(sourceStart, sourceEnd) !== range.removedText) return undefined;
    transformed.push({ sourceStart, sourceEnd });
  }
  return transformed;
}

function transformWithKnownEdits(
  currentText: string,
  ranges: readonly TextEditRange[],
  edits: readonly { sourceStart: number; sourceEnd: number; insertedLength: number }[],
): readonly TransformedTextEditRange[] | undefined {
  const transformed: TransformedTextEditRange[] = [];
  for (const range of ranges) {
    if (edits.some(edit => editsConflict(range, edit))) return undefined;
    const sourceStart = transformBoundary(range.sourceStart, 'start', edits);
    const sourceEnd = transformBoundary(range.sourceEnd, 'end', edits);
    if (currentText.slice(sourceStart, sourceEnd) !== range.removedText) return undefined;
    transformed.push({ sourceStart, sourceEnd });
  }
  return transformed;
}

function editsConflict(
  range: TextEditRange,
  edit: { sourceStart: number; sourceEnd: number; insertedLength: number },
): boolean {
  const rangeIsInsertion = range.sourceStart === range.sourceEnd;
  const editIsInsertion = edit.sourceStart === edit.sourceEnd;
  if (rangeIsInsertion) {
    if (editIsInsertion) return range.sourceStart === edit.sourceStart;
    return edit.sourceStart < range.sourceStart && edit.sourceEnd > range.sourceStart;
  }
  if (editIsInsertion) return edit.sourceStart > range.sourceStart && edit.sourceStart < range.sourceEnd;
  return edit.sourceStart < range.sourceEnd && edit.sourceEnd > range.sourceStart;
}

function distanceBetween(
  range: TextEditRange,
  edit: { sourceStart: number; sourceEnd: number; insertedLength: number },
): number {
  if (range.sourceEnd <= edit.sourceStart) return edit.sourceStart - range.sourceEnd;
  if (edit.sourceEnd <= range.sourceStart) return range.sourceStart - edit.sourceEnd;
  return 0;
}

function transformBoundary(
  offset: number,
  affinity: 'start' | 'end',
  edits: readonly { sourceStart: number; sourceEnd: number; insertedLength: number }[],
): number {
  let transformed = offset;
  for (const edit of edits) {
    const insertionAtBoundary = edit.sourceStart === edit.sourceEnd && edit.sourceStart === offset;
    const editIsBefore = edit.sourceEnd <= offset && !insertionAtBoundary;
    const insertionBelongsBefore = insertionAtBoundary && affinity === 'start';
    if (editIsBefore || insertionBelongsBefore) {
      transformed += edit.insertedLength - (edit.sourceEnd - edit.sourceStart);
    }
  }
  return transformed;
}

function shuffledIndexes(length: number, random: () => number): number[] {
  const values = Array.from({ length }, (_, index) => index);
  for (let index = values.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [values[index], values[swap]] = [values[swap]!, values[index]!];
  }
  return values;
}

function randomNumbers(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomText(length: number, random: () => number, alphabet: string): string {
  return Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
}
