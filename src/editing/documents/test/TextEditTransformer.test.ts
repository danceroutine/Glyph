import { describe, expect, it, vi } from 'vitest';
import { diffChars, type ChangeObject } from 'diff';
import { transformTextEditRanges } from '#src/editing/documents/transformTextEditRanges.js';

vi.mock('diff', { spy: true });

describe(transformTextEditRanges, () => {
  it('maps a range too large to anchor through the exact intervening edits', () => {
    const removed = 'x'.repeat(70_000);
    const previous = `a${removed}b`;

    expect(transformTextEditRanges(previous, `Z${previous}`, [range(1, 70_001, removed)])).toEqual([
      { sourceStart: 2, sourceEnd: 70_002 },
    ]);
  });

  it('rejects a range whose expected text changes while it is being mapped', () => {
    let reads = 0;
    const shifting = {
      sourceStart: 0,
      sourceEnd: 1,
      get removedText() {
        reads++;
        return reads < 3 ? 'a' : 'b';
      },
    };

    expect(transformTextEditRanges('abc', 'abcd', [shifting])).toBeUndefined();
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it('treats a character diff with missing entries as reporting no further changes', () => {
    const changes: ChangeObject<string>[] = [];
    changes.length = 1;
    vi.mocked(diffChars).mockReturnValueOnce(changes);

    const transformed = transformTextEditRanges('cc', 'ccc', [range(0, 0, '')]);

    expect(vi.mocked(diffChars).mock.results.at(-1)?.value).toBe(changes);
    expect(transformed).toEqual([{ sourceStart: 0, sourceEnd: 0 }]);
  });

  it('rejects a mapping whose expected text is absent from the current document', () => {
    const changes: ChangeObject<string>[] = [{ value: 'c', count: 1, added: false, removed: false }];
    vi.mocked(diffChars).mockReturnValueOnce(changes);

    const transformed = transformTextEditRanges('abc', 'abd', [range(2, 3, 'c')]);

    expect(vi.mocked(diffChars).mock.results.at(-1)?.value).toBe(changes);
    expect(transformed).toBeUndefined();
  });

  it('rejects a rebase that maps separate edits onto one surviving occurrence', () => {
    const previous = 'left\ntarget\nmiddle\ntarget\nright\n';
    const ranges = [range(5, 11, 'target'), range(19, 25, 'target')];
    expect(transformTextEditRanges(previous, 'left\ntarget\nright\n', ranges)).toBeUndefined();
  });

  it.each([
    ['mismatched text', [range(0, 3, 'wrong')]],
    ['overlapping replacements', [range(0, 2, 'ab'), range(1, 3, 'bc')]],
    ['duplicate insertions', [range(1, 1, ''), range(1, 1, '')]],
    ['insertion inside a replacement', [range(0, 3, 'abc'), range(1, 1, '')]],
    ['fractional offsets', [range(0.5, 2, 'ab')]],
    ['non-finite offsets', [range(Number.NaN, 2, 'ab')]],
  ])('rejects %s even when the document is unchanged', (_description, ranges) => {
    expect(transformTextEditRanges('abc', 'abc', ranges)).toBeUndefined();
  });

  it('rejects independently anchored edits whose document order has reversed', () => {
    const first = 'left-one unique\nfirst\nend-one unique\n';
    const second = 'left-two unique\nsecond\nend-two unique\n';
    const previous = first + second;
    const ranges = [
      range(previous.indexOf('first'), previous.indexOf('first') + 5, 'first'),
      range(previous.indexOf('second'), previous.indexOf('second') + 6, 'second'),
    ];
    expect(transformTextEditRanges(previous, second + first, ranges)).toBeUndefined();
  });

  it('keeps touching replacements and an insertion at their outer boundary distinct', () => {
    const ranges = [range(0, 1, 'a'), range(1, 2, 'b'), range(2, 2, '')];
    expect(transformTextEditRanges('abc', 'abc', ranges)).toEqual([
      { sourceStart: 0, sourceEnd: 1 },
      { sourceStart: 1, sourceEnd: 2 },
      { sourceStart: 2, sourceEnd: 2 },
    ]);
  });

  it('rejects insertion points that collapse together after the intervening text is removed', () => {
    expect(transformTextEditRanges('aXXb', 'ab', [range(1, 1, ''), range(3, 3, '')])).toBeUndefined();
  });

  it.each([false, true])(
    'rejects an insertion collapsing onto a replacement start with reversed input order %s',
    reverse => {
      const ranges = [range(1, 1, ''), range(3, 4, 'b')];
      if (reverse) ranges.reverse();
      expect(transformTextEditRanges('aXXb', 'ab', ranges)).toBeUndefined();
    },
  );

  it('rejects a shared insertion and replacement start even when the document is unchanged', () => {
    expect(transformTextEditRanges('ab', 'ab', [range(1, 1, ''), range(1, 2, 'b')])).toBeUndefined();
  });

  it('keeps ranges unchanged when the document did not change', () => {
    expect(transformTextEditRanges('alpha', 'alpha', [range(0, 5, 'alpha')])).toEqual([
      { sourceStart: 0, sourceEnd: 5 },
    ]);
  });

  it('moves a range past insertions and replacements before it', () => {
    expect(transformTextEditRanges('one\ntwo\nthree\n', 'zero\none\nTWO\nthree\n', [range(8, 13, 'three')])).toEqual([
      { sourceStart: 13, sourceEnd: 18 },
    ]);
  });

  it('keeps an insertion before an intervening replacement at the same boundary', () => {
    expect(transformTextEditRanges('abc', 'aBc', [range(1, 1, '')])).toEqual([{ sourceStart: 1, sourceEnd: 1 }]);
  });

  it('places an intervening insertion before a replacement that starts at the same boundary', () => {
    expect(transformTextEditRanges('abc', 'aXbc', [range(1, 2, 'b')])).toEqual([{ sourceStart: 2, sourceEnd: 3 }]);
  });

  it('places an intervening insertion after a replacement that ends at the same boundary', () => {
    expect(transformTextEditRanges('abc', 'abXc', [range(1, 2, 'b')])).toEqual([{ sourceStart: 1, sourceEnd: 2 }]);
  });

  it('rejects overlapping replacements', () => {
    expect(transformTextEditRanges('abcdef', 'abXYef', [range(1, 4, 'bcd')])).toBeUndefined();
  });

  it('rejects an insertion inside a replaced range', () => {
    expect(transformTextEditRanges('abcdef', 'abcXdef', [range(1, 5, 'bcde')])).toBeUndefined();
  });

  it('rejects competing insertions at the same offset', () => {
    expect(transformTextEditRanges('abc', 'aXbc', [range(1, 1, '')])).toBeUndefined();
  });

  it('rejects a proposal insertion swallowed by an intervening deletion', () => {
    expect(transformTextEditRanges('abcdef', 'abef', [range(3, 3, '')])).toBeUndefined();
  });

  it('rejects a range when its expected text no longer matches after mapping', () => {
    expect(transformTextEditRanges('abcabc', 'abcXabc', [range(3, 6, 'wrong')])).toBeUndefined();
  });

  it('matches the legacy character transformer across randomized sparse and overlapping edits', () => {
    const random = randomNumbers(19_840_205);
    for (let iteration = 0; iteration < 250; iteration++) {
      const lines = Array.from(
        { length: 100 },
        (_, index) => `record-${index.toString().padStart(3, '0')}:value-${index.toString().padStart(3, '0')}\n`,
      );
      const previous = lines.join('');
      const proposalLine = Math.floor(random() * lines.length);
      const proposalText = `value-${proposalLine.toString().padStart(3, '0')}`;
      const proposalStart = previous.indexOf(proposalText);
      const proposal = range(proposalStart, proposalStart + proposalText.length, proposalText);
      const changedLine = Math.floor(random() * lines.length);
      const changedText = `value-${changedLine.toString().padStart(3, '0')}`;
      const changedStart = previous.indexOf(changedText);
      const replacement = `human-${iteration.toString().padStart(3, '0')}`;
      const current = previous.slice(0, changedStart) + replacement + previous.slice(changedStart + changedText.length);

      expect(transformTextEditRanges(previous, current, [proposal])).toEqual(
        legacyTransform(previous, current, [proposal]),
      );
    }
  });
});

function range(sourceStart: number, sourceEnd: number, removedText: string) {
  return { sourceStart, sourceEnd, removedText };
}

function legacyTransform(previousText: string, currentText: string, ranges: readonly ReturnType<typeof range>[]) {
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
  const transformed = [];
  for (const proposal of ranges) {
    const conflict = edits.some(edit =>
      proposal.sourceStart === proposal.sourceEnd
        ? edit.sourceStart === edit.sourceEnd
          ? proposal.sourceStart === edit.sourceStart
          : edit.sourceStart < proposal.sourceStart && edit.sourceEnd > proposal.sourceStart
        : edit.sourceStart === edit.sourceEnd
          ? edit.sourceStart > proposal.sourceStart && edit.sourceStart < proposal.sourceEnd
          : edit.sourceStart < proposal.sourceEnd && edit.sourceEnd > proposal.sourceStart,
    );
    if (conflict) return undefined;
    const sourceStart = legacyBoundary(proposal.sourceStart, 'start', edits);
    const sourceEnd = legacyBoundary(proposal.sourceEnd, 'end', edits);
    if (currentText.slice(sourceStart, sourceEnd) !== proposal.removedText) return undefined;
    transformed.push({ sourceStart, sourceEnd });
  }
  return transformed;
}

function legacyBoundary(
  offset: number,
  affinity: 'start' | 'end',
  edits: readonly { sourceStart: number; sourceEnd: number; insertedLength: number }[],
) {
  let transformed = offset;
  for (const edit of edits) {
    const insertionAtBoundary = edit.sourceStart === edit.sourceEnd && edit.sourceStart === offset;
    if ((edit.sourceEnd <= offset && !insertionAtBoundary) || (insertionAtBoundary && affinity === 'start')) {
      transformed += edit.insertedLength - (edit.sourceEnd - edit.sourceStart);
    }
  }
  return transformed;
}

function randomNumbers(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
