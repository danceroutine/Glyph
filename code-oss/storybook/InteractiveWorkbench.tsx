import { useEffect, useRef, useState } from 'preact/hooks';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';
import { GlyphTranscriptRole } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import { WiredGlyphWorkbench } from '#code-oss/ui/GlyphWorkbench/GlyphWorkbench.wired.tsx';
import { conversation, selection, workbenchState, previewActions } from './fixtures.ts';

/** A local simulation for UI iteration. It never connects to the desktop host. */
export function InteractiveWorkbench() {
  const [composer] = useState(() => new GlyphComposerState());
  const [state, setState] = useState(() => workbenchState({ transcript: conversation, selection }));
  const [pending, setPending] = useState<{ id: string; response: string }>();
  const nextTurn = useRef(0);

  useEffect(() => {
    if (!pending) return;
    let length = 0;
    const timer = window.setInterval(() => {
      length = Math.min(length + 8, pending.response.length);
      const text = pending.response.slice(0, length);
      const finished = length === pending.response.length;
      setState(current => ({
        ...current,
        status: finished ? GlyphWorkbenchStatus.READY : GlyphWorkbenchStatus.STREAMING,
        transcript: current.transcript.map(entry => (entry.id === pending.id ? { ...entry, text } : entry)),
      }));
      if (finished) {
        window.clearInterval(timer);
        setPending(undefined);
      }
    }, 60);
    return () => window.clearInterval(timer);
  }, [pending]);

  return (
    <WiredGlyphWorkbench
      state={state}
      actions={{
        ...previewActions,
        composer,
        send: async text => {
          const turn = ++nextTurn.current;
          const id = `preview-assistant-${turn}`;
          setState(current => ({
            ...current,
            status: GlyphWorkbenchStatus.STREAMING,
            transcript: [
              ...current.transcript,
              { id: `preview-user-${turn}`, role: GlyphTranscriptRole.USER, text },
              { id, role: GlyphTranscriptRole.ASSISTANT, text: '' },
            ],
          }));
          setPending({
            id,
            response:
              'This is a simulated streaming response. Try resizing the pane, switching themes, or typing your next message while this reply arrives.\n\nCancel stops this reply; Send starts another. No model or workspace is connected.',
          });
        },
        cancel: () => {
          setPending(undefined);
          setState(current => ({ ...current, status: GlyphWorkbenchStatus.READY }));
        },
      }}
    />
  );
}
