import { diffChars } from 'diff';

const TRANSFORM_TIMEOUT_MILLISECONDS = 1_000;
const INITIAL_ANCHOR_CONTEXT = 32;
const MAXIMUM_ANCHOR_CONTEXT = 4_096;
const MAXIMUM_ANCHORED_RANGE = 64 * 1024;

export interface TextEditRange {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly removedText: string;
}

export interface TransformedTextEditRange {
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

interface InterveningEdit {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly insertedLength: number;
}

/**
 * Maps UTF-16 edit ranges from one document revision onto a newer revision.
 * Sparse changes use unique unchanged context and avoid a document-sized diff.
 * Ambiguous cases retain the exact character-diff fallback, so optimization
 * never trades successful merges for faster conflicts.
 */
export function transformTextEditRanges(
  previousText: string,
  currentText: string,
  ranges: readonly TextEditRange[],
): readonly TransformedTextEditRange[] | undefined {
  if (previousText === currentText) return copyRanges(ranges);
  if (!ranges.every(range => isValidRange(previousText, range))) return undefined;

  const anchored = transformWithUniqueAnchors(previousText, currentText, ranges);
  if (anchored) return anchored;

  const interveningEdits = findExactInterveningEdits(previousText, currentText);
  if (!interveningEdits) return undefined;
  return transformWithInterveningEdits(currentText, ranges, interveningEdits);
}

function copyRanges(ranges: readonly TextEditRange[]): TransformedTextEditRange[] {
  return ranges.map(({ sourceStart, sourceEnd }) => ({ sourceStart, sourceEnd }));
}

function isValidRange(text: string, range: TextEditRange): boolean {
  return (
    range.sourceStart >= 0 &&
    range.sourceEnd >= range.sourceStart &&
    range.sourceEnd <= text.length &&
    text.slice(range.sourceStart, range.sourceEnd) === range.removedText
  );
}

function transformWithUniqueAnchors(
  previousText: string,
  currentText: string,
  ranges: readonly TextEditRange[],
): TransformedTextEditRange[] | undefined {
  const transformed: TransformedTextEditRange[] = [];
  for (const range of ranges) {
    const mapped = findUniqueAnchoredRange(previousText, currentText, range);
    if (!mapped) return undefined;
    transformed.push(mapped);
  }
  return transformed;
}

function findUniqueAnchoredRange(
  previousText: string,
  currentText: string,
  range: TextEditRange,
): TransformedTextEditRange | undefined {
  if (range.sourceEnd - range.sourceStart > MAXIMUM_ANCHORED_RANGE) return undefined;
  for (let context = INITIAL_ANCHOR_CONTEXT; context <= MAXIMUM_ANCHOR_CONTEXT; context *= 2) {
    const contexts =
      range.sourceStart === range.sourceEnd
        ? ([[context, context]] as const)
        : ([
            [context, 0],
            [0, context],
            [context, context],
          ] as const);
    for (const [before, after] of contexts) {
      const mapped = mapWithUniqueAnchor(previousText, currentText, range, before, after);
      if (mapped) return mapped;
    }
  }
  return undefined;
}

function mapWithUniqueAnchor(
  previousText: string,
  currentText: string,
  range: TextEditRange,
  contextBefore: number,
  contextAfter: number,
): TransformedTextEditRange | undefined {
  const anchorStart = Math.max(0, range.sourceStart - contextBefore);
  const anchorEnd = Math.min(previousText.length, range.sourceEnd + contextAfter);
  const anchor = previousText.slice(anchorStart, anchorEnd);
  if (anchor.length === 0 || !isUniqueAt(previousText, anchor, anchorStart)) return undefined;
  const currentAnchorStart = uniqueIndexOf(currentText, anchor);
  if (currentAnchorStart === undefined) return undefined;
  const sourceStart = currentAnchorStart + range.sourceStart - anchorStart;
  const sourceEnd = sourceStart + range.removedText.length;
  return currentText.slice(sourceStart, sourceEnd) === range.removedText ? { sourceStart, sourceEnd } : undefined;
}

function isUniqueAt(text: string, value: string, expectedIndex: number): boolean {
  return text.indexOf(value) === expectedIndex && text.indexOf(value, expectedIndex + 1) < 0;
}

function uniqueIndexOf(text: string, value: string): number | undefined {
  const index = text.indexOf(value);
  return index >= 0 && text.indexOf(value, index + 1) < 0 ? index : undefined;
}

function findExactInterveningEdits(previousText: string, currentText: string): InterveningEdit[] | undefined {
  const prefixLength = commonPrefixLength(previousText, currentText);
  const suffixLength = commonSuffixLength(previousText, currentText, prefixLength);
  const previousMiddle = previousText.slice(prefixLength, previousText.length - suffixLength);
  const currentMiddle = currentText.slice(prefixLength, currentText.length - suffixLength);
  const changes = diffChars(previousMiddle, currentMiddle, { timeout: TRANSFORM_TIMEOUT_MILLISECONDS });
  if (!changes) return undefined;

  const edits: InterveningEdit[] = [];
  let sourceOffset = prefixLength;
  for (let index = 0; index < changes.length;) {
    const change = changes[index];
    if (!change) break;
    if (!change.added && !change.removed) {
      sourceOffset += change.value.length;
      index++;
      continue;
    }

    const sourceStart = sourceOffset;
    let insertedLength = 0;
    while (index < changes.length) {
      const part = changes[index];
      if (!part || (!part.added && !part.removed)) break;
      if (part.removed) sourceOffset += part.value.length;
      if (part.added) insertedLength += part.value.length;
      index++;
    }
    edits.push({ sourceStart, sourceEnd: sourceOffset, insertedLength });
  }
  return edits;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let offset = 0;
  while (offset < limit && left.charCodeAt(offset) === right.charCodeAt(offset)) offset++;
  return offset;
}

function commonSuffixLength(left: string, right: string, prefixLength: number): number {
  const limit = Math.min(left.length, right.length) - prefixLength;
  let offset = 0;
  while (offset < limit && left.charCodeAt(left.length - offset - 1) === right.charCodeAt(right.length - offset - 1)) {
    offset++;
  }
  return offset;
}

function transformWithInterveningEdits(
  currentText: string,
  ranges: readonly TextEditRange[],
  edits: readonly InterveningEdit[],
): TransformedTextEditRange[] | undefined {
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

function editsConflict(range: TextEditRange, edit: InterveningEdit): boolean {
  const rangeIsInsertion = range.sourceStart === range.sourceEnd;
  const editIsInsertion = edit.sourceStart === edit.sourceEnd;
  if (rangeIsInsertion) {
    if (editIsInsertion) return range.sourceStart === edit.sourceStart;
    return edit.sourceStart < range.sourceStart && edit.sourceEnd > range.sourceStart;
  }
  if (editIsInsertion) return edit.sourceStart > range.sourceStart && edit.sourceStart < range.sourceEnd;
  return edit.sourceStart < range.sourceEnd && edit.sourceEnd > range.sourceStart;
}

function transformBoundary(offset: number, affinity: 'start' | 'end', edits: readonly InterveningEdit[]): number {
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
