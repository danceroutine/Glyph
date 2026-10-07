import type { ChatResponsePart } from '#src/chat/ChatResponsePart.ts';
import type { PromptRequest } from '../prompt/PromptRequest.ts';
import type { ProposalReviewRequest } from '../proposal/ProposalReviewRequest.ts';
import type { QuestionFormRequest } from '../question/QuestionFormRequest.ts';
import type { ShellSessionSnapshot } from '#src/shell/ShellSessionSnapshot.ts';
import type { TerminalShellPermissionRequest } from '../shell-permission/ShellPermissionRequest.ts';
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
