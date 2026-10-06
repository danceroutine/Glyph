import type { WorkspacePathIndex } from '../../../context/search/WorkspacePathIndex.ts';
import type { UserPromptDraft } from './UserPromptDraft.ts';

/** Event bridge exposed to the prompt component for one pending host request. */
export interface PromptRequest {
  id: number;
  label: string;
  pendingChanges?: number;
  files?: WorkspacePathIndex;
  complete: (draft: UserPromptDraft) => void;
}
