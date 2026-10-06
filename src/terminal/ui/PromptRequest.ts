import type { WorkspaceFileSearch } from '../../context/search/WorkspaceFileSearch.ts';
import type { UserPromptDraft } from '../UserPromptDraft.ts';

/** Event bridge exposed to the prompt component for one pending host request. */
export interface PromptRequest {
  id: number;
  label: string;
  files?: WorkspaceFileSearch;
  complete: (draft: UserPromptDraft) => void;
}
