import type { ChatResponsePart } from '../../chat/ChatResponsePart.ts';
import type { PromptRequest } from './PromptRequest.ts';
import type { ProposalReviewRequest } from './ProposalReviewRequest.ts';
import type { TranscriptEntry } from './TranscriptEntry.ts';

/** Immutable view of renderer-owned state supplied to the React tree. */
export interface TerminalRendererSnapshot {
  entries: readonly TranscriptEntry[];
  responseParts: readonly ChatResponsePart[] | undefined;
  prompt: PromptRequest | undefined;
  review: ProposalReviewRequest | undefined;
  interrupt: () => void;
}
