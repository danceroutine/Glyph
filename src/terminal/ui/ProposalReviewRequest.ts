import type { ProposalReviewManager } from '../../editing/reviews/ProposalReviewManager.ts';

/** Host-owned review interaction consumed by the proposal-review component. */
export interface ProposalReviewRequest {
  id: number;
  manager: ProposalReviewManager;
  complete: () => void;
  interrupt: () => void;
}
