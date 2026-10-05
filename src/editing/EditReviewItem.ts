import type { EditDecisionState } from './EditDecisionState.ts';
import type { EditReviewItemKind } from './EditReviewItemKind.ts';

export interface EditReviewItem {
  readonly id: string;
  readonly fileId: string;
  readonly kind: EditReviewItemKind;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly removedText: string;
  readonly insertedText: string;
  decision: EditDecisionState;
}
