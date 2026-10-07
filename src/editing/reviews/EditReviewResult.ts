import type { EditDecisionState } from './EditDecisionState.ts';
import type { EditReviewItemKind } from './EditReviewItemKind.ts';

export interface EditReviewResultItem {
  readonly itemId: string;
  readonly fileId: string;
  readonly kind: EditReviewItemKind;
  readonly decision: Exclude<EditDecisionState, EditDecisionState.PENDING>;
  readonly affectedPaths: readonly string[];
  readonly resultingRevision: string | null;
}

/** Durable, model-facing receipt for one fully settled proposal review. */
export interface EditReviewResult {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly reviewId: string;
  readonly items: readonly EditReviewResultItem[];
}
