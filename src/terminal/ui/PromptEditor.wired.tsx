import type { ReactElement } from 'react';
import { PromptEditorPresentational } from './PromptEditor.presentational.tsx';
import type { PromptRequest } from './PromptRequest.ts';
import { usePromptEditorState } from './usePromptEditorState.ts';

export interface PromptEditorWiredProps {
  request: PromptRequest;
  interrupt: () => void;
}

export function PromptEditorWired(props: PromptEditorWiredProps): ReactElement {
  const state = usePromptEditorState(props);
  return <PromptEditorPresentational {...state} />;
}
