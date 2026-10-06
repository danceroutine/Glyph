import type { EditDecisionState } from './EditDecisionState.ts';
import type { EditReviewItemKind } from './EditReviewItemKind.ts';

export interface EditReviewItem {
  readonly id: string;
  readonly fileId: string;
  readonly kind: EditReviewItemKind;
  sourceStart: number;
  sourceEnd: number;
  readonly removedText: string;
  readonly insertedText: string;
  decision: EditDecisionState;
}
