import type { WorkspacePathIndex } from '#src/context/search/WorkspacePathIndex.ts';
import type { UserPromptDraft } from './UserPromptDraft.ts';

/** Event bridge exposed to the prompt component for one pending host request. */
interface PromptRequestBase {
  id: number;
  label: string;
  pendingChanges?: number;
  files?: WorkspacePathIndex;
}

export interface ActivePromptRequest extends PromptRequestBase {
  acceptsSubmission: true;
  complete: (draft: UserPromptDraft) => void;
}

export interface DraftPromptRequest extends PromptRequestBase {
  acceptsSubmission: false;
}

export type PromptRequest = ActivePromptRequest | DraftPromptRequest;
