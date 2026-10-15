import type { EditReviewItem } from '#src/editing/reviews/EditReviewItem.js';

/** Converts exact Base and Proposed text into independently reviewable changes. */
export interface TextDiffer {
  createReviewItems(fileId: string, base: string, proposed: string, options: { timeoutMs: number }): EditReviewItem[];
}
