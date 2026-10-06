import type { EditProposal } from '../../proposals/EditProposal.ts';

/**
 * Durable checkpoint port for active proposal reviews.
 *
 * Implementations persist the complete collection atomically so a host can
 * recover proposals staged by multiple actors without coupling this domain to
 * a particular filesystem or editor storage API.
 */
export interface ProposalReviewStore {
  load(): Promise<EditProposal[]>;
  save(proposals: readonly EditProposal[]): Promise<void>;
  clear(): Promise<void>;
}
