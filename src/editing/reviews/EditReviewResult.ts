import type { EditDecisionState } from './EditDecisionState.ts';
import type { EditReviewItemKind } from './EditReviewItemKind.ts';
import type { EditProposalOrigin } from '../proposals/EditProposalOrigin.ts';

export interface EditReviewResultItem {
  readonly itemId: string;
  readonly fileId: string;
  readonly kind: EditReviewItemKind;
  readonly decision: Exclude<EditDecisionState, EditDecisionState.PENDING>;
  readonly affectedPaths: readonly string[];
  readonly resultingRevision: string | null;
}

/** Durable, model-facing receipt for one review decision. */
export interface EditReviewResult {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly reviewId: string;
  readonly origin?: EditProposalOrigin;
  readonly items: readonly EditReviewResultItem[];
}
