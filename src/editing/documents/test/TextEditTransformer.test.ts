import { describe, expect, it } from 'vitest';
import { diffChars } from 'diff';
import { transformTextEditRanges } from '../transformTextEditRanges.ts';

describe(transformTextEditRanges, () => {
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
