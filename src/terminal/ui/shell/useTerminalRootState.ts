import { useMemo } from 'react';
import type { ChatResponsePart } from '#src/chat/ChatResponsePart.js';
import type { PromptRequest } from '#src/terminal/ui/prompt/PromptRequest.js';
import type { ProposalReviewRequest } from '#src/terminal/ui/proposal/ProposalReviewRequest.js';
import type { QuestionFormRequest } from '#src/terminal/ui/question/QuestionFormRequest.js';
import type { ShellSessionSnapshot } from '#src/shell/ShellSessionSnapshot.js';
import type { TerminalShellPermissionRequest } from '#src/terminal/ui/shell-permission/ShellPermissionRequest.js';
import type { TerminalRendererSnapshot } from './TerminalRendererSnapshot.ts';
import type { TranscriptEntry } from './TranscriptEntry.ts';

/** Root component contract separating renderer state from tree composition. */
export interface TerminalRootState {
  entries: readonly TranscriptEntry[];
  responseParts: readonly ChatResponsePart[] | undefined;
  prompt: PromptRequest | undefined;
  question: QuestionFormRequest | undefined;
  shellPermission: TerminalShellPermissionRequest | undefined;
  backgroundShells: readonly ShellSessionSnapshot[];
  review: ProposalReviewRequest | undefined;
  interrupt: () => void;
}

export function useTerminalRootState(snapshot: TerminalRendererSnapshot): TerminalRootState {
  return useMemo(
    () => ({
      entries: snapshot.entries,
      responseParts: snapshot.responseParts,
      prompt: snapshot.prompt,
      question: snapshot.question,
      shellPermission: snapshot.shellPermission,
      backgroundShells: snapshot.backgroundShells,
      review: snapshot.review,
      interrupt: snapshot.interrupt,
    }),
    [
      snapshot.backgroundShells,
      snapshot.entries,
      snapshot.interrupt,
      snapshot.prompt,
      snapshot.question,
      snapshot.responseParts,
      snapshot.review,
      snapshot.shellPermission,
    ],
  );
}
