import type { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.ts';
import type { ProposalReviewSummary } from './ProposalReviewSummary.ts';

/** Host-owned review interaction consumed by the proposal-review component. */
export interface ProposalReviewRequest {
  id: number;
  manager: ProposalReviewManager;
  complete: (summary?: ProposalReviewSummary) => void;
  interrupt: () => void;
}
