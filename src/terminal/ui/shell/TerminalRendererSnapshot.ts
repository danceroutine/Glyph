import type { ChatResponsePart } from '#src/chat/ChatResponsePart.js';
import type { PromptRequest } from '#src/terminal/ui/prompt/PromptRequest.js';
import type { ProposalReviewRequest } from '#src/terminal/ui/proposal/ProposalReviewRequest.js';
import type { QuestionFormRequest } from '#src/terminal/ui/question/QuestionFormRequest.js';
import type { ShellSessionSnapshot } from '#src/shell/ShellSessionSnapshot.js';
import type { TerminalShellPermissionRequest } from '#src/terminal/ui/shell-permission/ShellPermissionRequest.js';
import type { TranscriptEntry } from './TranscriptEntry.ts';

/** Immutable view of renderer-owned state supplied to the React tree. */
export interface TerminalRendererSnapshot {
  entries: readonly TranscriptEntry[];
  responseParts: readonly ChatResponsePart[] | undefined;
  prompt: PromptRequest | undefined;
  question?: QuestionFormRequest;
  shellPermission?: TerminalShellPermissionRequest;
  backgroundShells: readonly ShellSessionSnapshot[];
  review: ProposalReviewRequest | undefined;
  interrupt: () => void;
}
