import type { EditReviewItem } from './EditReviewItem.ts';

export interface TextDiffer {
  createReviewItems(fileId: string, base: string, proposed: string): EditReviewItem[];
}
