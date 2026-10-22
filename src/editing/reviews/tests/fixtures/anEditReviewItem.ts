import type { EditReviewItem } from '#src/editing/reviews/EditReviewItem.ts';
import { EditReviewItemKind } from '#src/editing/reviews/EditReviewItemKind.ts';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.ts';

export const anEditReviewItem = ({ ...rest }: Partial<EditReviewItem>): EditReviewItem => ({
  id: 'item',
  fileId: 'file',
  kind: EditReviewItemKind.CREATE,
  sourceStart: 0,
  sourceEnd: 0,
  removedText: 'removedText',
  insertedText: 'insertedText',
  decision: EditDecisionState.ACCEPTED,
  ...rest,
});
