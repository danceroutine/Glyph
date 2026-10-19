import type { FileEditPlan } from '#src/editing/proposals/FileEditPlan.js';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.js';
import { EditReviewItemKind } from '#src/editing/reviews/EditReviewItemKind.js';
import type { GlyphProposalFilePreview } from '#src/desktop/protocol/events/GlyphProposalFilePreview.js';

/** Build the remaining diff from the live review baseline, including prior accepted decisions. */
export function toGlyphProposalFilePreview(proposalId: string, file: FileEditPlan): GlyphProposalFilePreview {
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
