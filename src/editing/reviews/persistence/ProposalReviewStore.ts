import type { EditProposal } from '../../proposals/EditProposal.ts';

/** Durable checkpoint port for the currently active proposal review. */
export interface ProposalReviewStore {
  load(): Promise<EditProposal | undefined>;
  save(proposal: EditProposal): Promise<void>;
  clear(): Promise<void>;
}
