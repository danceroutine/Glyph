import type { FileEditPlan } from '#src/editing/proposals/FileEditPlan.js';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.js';
import { EditReviewItemKind } from '#src/editing/reviews/EditReviewItemKind.js';
import type { GlyphProposalFilePreview } from '#src/desktop/protocol/events/GlyphProposalFilePreview.js';
import { planTextRevert } from '#src/editing/reviews/AppliedTextEdit.js';
import { isReviewItemPending } from '#src/editing/reviews/isReviewItemPending.js';
import { transformTextEditRanges } from '#src/editing/documents/transformTextEditRanges.js';

/** Build the remaining diff from the live review baseline, including prior accepted decisions. */
export function toGlyphProposalFilePreview(proposalId: string, file: FileEditPlan): GlyphProposalFilePreview {
  if (file.items.some(item => item.appliedText?.after) && file.current) {
    const after = file.current.text;
    let before = { ...file.current };
    const pending = file.items.filter(item => item.appliedText?.after && isReviewItemPending(file, item));
    for (const item of [...pending].reverse()) {
      const inverse = planTextRevert(item.appliedText!, before);
      if (inverse) before = { ...before, ...inverse };
    }
    return {
      proposalId,
      fileId: file.id,
      before: file.automatic?.before?.text ?? before.text,
      after,
      items: [
        ...(file.automatic &&
        isReviewItemPending(
          file,
          file.items.find(item => item.id === file.automatic!.itemId)!,
        )
          ? [{ id: file.automatic.itemId, lineNumber: 1 }]
          : []),
        ...pending.map(item => {
          const observed = item.appliedText!.after!.text;
          const start = item.sourceStart;
          const ranges = transformTextEditRanges(observed, after, [
            {
              sourceStart: start,
              sourceEnd: start + item.insertedText.length,
              removedText: item.insertedText,
            },
          ]);
          return {
            id: item.id,
            lineNumber: after.slice(0, ranges?.[0]?.sourceStart ?? start).split(/\r\n|\r|\n/).length,
          };
        }),
      ],
    };
  }
  if (file.automatic && file.automatic.state !== 'applying') {
    return {
      proposalId,
      fileId: file.id,
      before: file.automatic.before?.text ?? '',
      after: file.operation === 'DELETE' ? '' : file.proposed.text,
      items: [
        { id: file.automatic.itemId, lineNumber: 1 },
        ...file.items
          .filter(item => item.kind === EditReviewItemKind.TEXT && item.decision === EditDecisionState.PENDING)
          .map(item => ({
            id: item.id,
            lineNumber: (file.base?.text ?? '').slice(0, item.sourceStart).split(/\r\n|\r|\n/).length,
          })),
      ],
    };
  }
  const before = file.current?.text ?? file.base?.text ?? '';
  let after = before;
  const pending = file.items.filter(
    item => item.decision === EditDecisionState.PENDING && item.kind === EditReviewItemKind.TEXT,
  );
  for (const item of [...pending].sort((a, b) => b.sourceStart - a.sourceStart))
    after = after.slice(0, item.sourceStart) + item.insertedText + after.slice(item.sourceEnd);
  let offset = 0;
  const items = [...pending]
    .sort((a, b) => a.sourceStart - b.sourceStart)
    .map(item => {
      const lineNumber = after.slice(0, item.sourceStart + offset).split(/\r\n|\r|\n/).length;
      offset += item.insertedText.length - (item.sourceEnd - item.sourceStart);
      return { id: item.id, lineNumber };
    });
  return { proposalId, fileId: file.id, before, after, items };
}
