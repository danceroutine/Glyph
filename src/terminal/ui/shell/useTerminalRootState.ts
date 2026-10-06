import { useMemo } from 'react';
import type { ChatResponsePart } from '../../../chat/ChatResponsePart.ts';
import type { PromptRequest } from '../prompt/PromptRequest.ts';
import type { ProposalReviewRequest } from '../proposal/ProposalReviewRequest.ts';
import type { TerminalRendererSnapshot } from './TerminalRendererSnapshot.ts';
import type { TranscriptEntry } from './TranscriptEntry.ts';

/** Root component contract separating renderer state from tree composition. */
export interface TerminalRootState {
  entries: readonly TranscriptEntry[];
  responseParts: readonly ChatResponsePart[] | undefined;
  prompt: PromptRequest | undefined;
  review: ProposalReviewRequest | undefined;
  interrupt: () => void;
}

export function useTerminalRootState(snapshot: TerminalRendererSnapshot): TerminalRootState {
  return useMemo(
    () => ({
      entries: snapshot.entries,
      responseParts: snapshot.responseParts,
      prompt: snapshot.prompt,
      review: snapshot.review,
      interrupt: snapshot.interrupt,
    }),
    [snapshot.entries, snapshot.interrupt, snapshot.prompt, snapshot.responseParts, snapshot.review],
  );
}
