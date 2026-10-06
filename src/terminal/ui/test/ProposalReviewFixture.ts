import { vi } from 'vitest';
import { EditOperation } from '../../../editing/proposals/EditOperation.ts';
import type { EditProposal } from '../../../editing/proposals/EditProposal.ts';
import { EditApplicabilityState } from '../../../editing/reviews/EditApplicabilityState.ts';
import { EditDecisionState } from '../../../editing/reviews/EditDecisionState.ts';
import { EditReviewItemKind } from '../../../editing/reviews/EditReviewItemKind.ts';
import type { ProposalReviewManager } from '../../../editing/reviews/ProposalReviewManager.ts';

export interface ProposalReviewFixture {
  manager: ProposalReviewManager;
  proposal: EditProposal;
  accept: ReturnType<typeof vi.fn<ProposalReviewManager['acceptInReview']>>;
  reject: ReturnType<typeof vi.fn<ProposalReviewManager['rejectInReview']>>;
}

export function createProposalReviewFixture(): ProposalReviewFixture {
  const base = {
    path: 'src/App.tsx',
    text: 'old\ncontext\nmore\nlines\nfor\nscrolling\n',
    byteOrderMark: false,
    mode: 0o644,
    byteLength: 37,
    revision: 'base',
    identity: 'identity',
  };
  const item = {
    id: 'item',
    fileId: 'file',
    kind: EditReviewItemKind.TEXT,
    sourceStart: 0,
    sourceEnd: 3,
    removedText: 'old',
    insertedText: 'new',
    decision: EditDecisionState.PENDING,
  };
  const proposal: EditProposal = {
    schemaVersion: 1,
    id: 'proposal',
    source: 'structured',
    createdAt: '2026-10-06T00:00:00.000Z',
    files: [
      {
        id: 'file',
        operation: EditOperation.UPDATE,
        sourcePath: 'src/App.tsx',
        targetPath: 'src/App.tsx',
        base,
        proposed: { ...base, text: 'new\ncontext\nmore\nlines\nfor\nscrolling\n', revision: 'proposed' },
        items: [item],
        current: base,
        applyingItemId: null,
        createdDirectories: [],
        applicability: EditApplicabilityState.READY,
        currentPath: 'src/App.tsx',
        currentRevision: 'base',
      },
    ],
  };
  const accept = vi.fn<ProposalReviewManager['acceptInReview']>(async () => {
    item.decision = EditDecisionState.ACCEPTED;
  });
  const reject = vi.fn<ProposalReviewManager['rejectInReview']>(async () => {
    item.decision = EditDecisionState.REJECTED;
  });
  const manager = {
    activeReviews: [proposal],
    acceptInReview: accept,
    rejectInReview: reject,
  } as unknown as ProposalReviewManager;
  return { manager, proposal, accept, reject };
}
