import type { EditReviewItem } from '../reviews/EditReviewItem.ts';

/** Converts exact Base and Proposed text into independently reviewable changes. */
export interface TextDiffer {
  createReviewItems(fileId: string, base: string, proposed: string): EditReviewItem[];
}
