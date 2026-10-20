import type { WorkspaceTextSnapshot } from '#src/workspace/WorkspaceTextSnapshot.js';
import { JsDiffTextDiffer } from '#src/editing/documents/JsDiffTextDiffer.js';
import { transformTextEditRanges } from '#src/editing/documents/transformTextEditRanges.js';

/** Observed edit boundaries, retained until the human keeps or reverts the hunk. */
export interface AppliedTextEdit {
  state: 'applying' | 'applied' | 'reverting' | 'reverted' | 'kept';
  before: WorkspaceTextSnapshot | null;
  after: WorkspaceTextSnapshot | null;
  revertTarget: WorkspaceTextSnapshot | null;
}

/** Reverse only this edit; disjoint later edits survive and overlapping edits fail closed. */
export function planTextRevert(
  edit: AppliedTextEdit,
  current: WorkspaceTextSnapshot,
): { text: string; byteOrderMark: boolean } | undefined {
  const { before, after } = edit;
  if (!before || !after) return undefined;
  const changesEncoding = before.byteOrderMark !== after.byteOrderMark;
  if (changesEncoding && current.byteOrderMark !== after.byteOrderMark) return undefined;
  const inverse = new JsDiffTextDiffer().createReviewItems('revert', after.text, before.text, { timeoutMs: 1000 });
  const ranges = transformTextEditRanges(after.text, current.text, inverse);
  if (!ranges) return undefined;
  let text = current.text;
  for (let index = inverse.length - 1; index >= 0; index--) {
    const range = ranges[index]!;
    text = text.slice(0, range.sourceStart) + inverse[index]!.insertedText + text.slice(range.sourceEnd);
  }
  return { text, byteOrderMark: changesEncoding ? before.byteOrderMark : current.byteOrderMark };
}
