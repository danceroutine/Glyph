import type { AgentReview } from './AgentReview.ts';

export interface AgentReviewStore {
  load(): Promise<readonly AgentReview[]>;
  save(review: AgentReview): Promise<void>;
  dispose(): Promise<void>;
}
