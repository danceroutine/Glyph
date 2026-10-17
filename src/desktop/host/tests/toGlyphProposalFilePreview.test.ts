import { describe, expect, it } from 'vitest';
import { toGlyphProposalFilePreview } from '#src/desktop/host/toGlyphProposalFilePreview.js';
import type { FileEditPlan } from '#src/editing/proposals/FileEditPlan.js';
import { EditOperation } from '#src/editing/proposals/EditOperation.js';
import { EditApplicabilityState } from '#src/editing/reviews/EditApplicabilityState.js';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.js';
import { EditReviewItemKind } from '#src/editing/reviews/EditReviewItemKind.js';

const snapshot = {
  path: 'file.ts',
  identity: '/workspace/file.ts',
  text: 'first\r\n🌱\r\nlast\r\n',
  byteOrderMark: false,
  revision: 'current',
  byteLength: 21,
  mode: 0o644,
};
function plan(): FileEditPlan {
  return {
    id: 'file',
    operation: EditOperation.UPDATE,
    sourcePath: 'file.ts',
    targetPath: 'file.ts',
    base: snapshot,
    current: snapshot,
    proposed: { ...snapshot, text: 'an outdated complete proposal' },
    applyingItemId: null,
    createdDirectories: [],
    applicability: EditApplicabilityState.READY,
    currentPath: 'file.ts',
    currentRevision: 'current',
    items: [
      {
        id: 'last',
        fileId: 'file',
        kind: EditReviewItemKind.TEXT,
        sourceStart: 11,
        sourceEnd: 17,
        removedText: 'last\r\n',
        insertedText: 'LAST\r\n',
        decision: EditDecisionState.PENDING,
      },
      {
        id: 'first',
        fileId: 'file',
        kind: EditReviewItemKind.TEXT,
        sourceStart: 0,
        sourceEnd: 7,
        removedText: 'first\r\n',
        insertedText: 'FIRST\r\nextra\r\n',
        decision: EditDecisionState.PENDING,
      },
      {
        id: 'rejected',
        fileId: 'file',
        kind: EditReviewItemKind.TEXT,
        sourceStart: 7,
        sourceEnd: 11,
        removedText: '🌱\r\n',
        insertedText: 'discarded\r\n',
        decision: EditDecisionState.REJECTED,
      },
    ],
  };
}

describe(toGlyphProposalFilePreview, () => {
  it('composes only pending items and locates them after preceding insertions without splitting Unicode or CRLF', () => {
    expect(toGlyphProposalFilePreview('proposal', plan())).toEqual({
      proposalId: 'proposal',
      fileId: 'file',
      before: snapshot.text,
      after: 'FIRST\r\nextra\r\n🌱\r\nLAST\r\n',
      items: [
        { id: 'first', lineNumber: 1 },
        { id: 'last', lineNumber: 4 },
      ],
    });
  });
  it('uses the current accepted baseline instead of the original proposal text', () => {
    const file = plan();
    file.items[1]!.decision = EditDecisionState.ACCEPTED;
    file.current = { ...snapshot, text: 'FIRST\r\n🌱\r\nlast\r\n' };
    const preview = toGlyphProposalFilePreview('proposal', file);
    expect(preview.before).toBe(file.current!.text);
    expect(preview.after).toBe('FIRST\r\n🌱\r\nLAST\r\n');
    expect(preview.items).toEqual([{ id: 'last', lineNumber: 3 }]);
  });
});
