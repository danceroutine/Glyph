import type { AgentReviewInput, AgentReviewModel } from './AgentReview.ts';

/** Implementations expose only read capabilities and own no UI or active-chat state. */
export interface AgentReviewExecutor {
  run(review: AgentReviewInput & AgentReviewModel, onText: (delta: string) => void, signal: AbortSignal): Promise<void>;
}
