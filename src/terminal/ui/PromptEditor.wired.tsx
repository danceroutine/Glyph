import type { ReactElement } from 'react';
import { PromptEditor } from './PromptEditor.presentational.tsx';
import type { PromptRequest } from './PromptRequest.ts';
import { usePromptEditorState } from './usePromptEditorState.ts';

export interface WiredPromptEditorProps {
  request: PromptRequest;
  interrupt: () => void;
}

export function WiredPromptEditor(props: WiredPromptEditorProps): ReactElement {
  const state = usePromptEditorState(props);
  return <PromptEditor {...state} />;
}
