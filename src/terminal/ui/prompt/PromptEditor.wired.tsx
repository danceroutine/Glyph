import { useRef, type ReactElement } from 'react';
import { useBoxMetrics, type DOMElement } from 'ink';
import { PromptEditor } from './PromptEditor.presentational.tsx';
import type { PromptRequest } from './PromptRequest.ts';
import { usePromptEditorState } from './usePromptEditorState.ts';

export interface WiredPromptEditorProps {
  request: PromptRequest;
  interrupt: () => void;
}

export function WiredPromptEditor(props: WiredPromptEditorProps): ReactElement {
  const rootRef = useRef<DOMElement | null>(null);
  const { top } = useBoxMetrics(rootRef);
  const state = usePromptEditorState({ ...props, railTop: top });
  return <PromptEditor {...state} rootRef={rootRef} />;
}
