import { useEffect, useRef, useState, type ReactElement } from 'react';
import { measureElement, useBoxMetrics, type DOMElement } from 'ink';
import { PromptEditor } from './PromptEditor.presentational.tsx';
import type { PromptRequest } from './PromptRequest.ts';
import { usePromptEditorState } from './usePromptEditorState.ts';

export interface WiredPromptEditorProps {
  request: PromptRequest;
  interrupt: () => void;
  active?: boolean;
}

export function WiredPromptEditor({ active = true, ...props }: WiredPromptEditorProps): ReactElement {
  const rootRef = useRef<DOMElement | null>(null);
  const metrics = useBoxMetrics(rootRef);
  const [railTop, setRailTop] = useState<number>();
  useEffect(() => {
    const root = rootRef.current;
    const nextTop = metrics.hasMeasured && root ? measureElement(root).y : undefined;
    setRailTop(current => (current === nextTop ? current : nextTop));
  }, [metrics.hasMeasured, metrics.height, metrics.left, metrics.top, metrics.width]);
  const state = usePromptEditorState({ ...props, active, railTop });
  return <PromptEditor {...state} rootRef={rootRef} />;
}
