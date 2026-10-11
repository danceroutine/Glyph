import { useRef, useState } from 'preact/hooks';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchSelection } from '#src/desktop/workbench/GlyphWorkbenchSelection.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';

interface GlyphComposerProps {
  readonly status: GlyphWorkbenchStatus;
  readonly selection: GlyphWorkbenchSelection | undefined;
  readonly actions: GlyphWorkbenchViewActions;
}

/** Owns draft state locally so host updates cannot erase what the user is typing. */
export function GlyphComposer({ status, selection, actions }: GlyphComposerProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const submitting = useRef(false);
  const active =
    status === GlyphWorkbenchStatus.STREAMING ||
    status === GlyphWorkbenchStatus.WAITING_FOR_QUESTION ||
    status === GlyphWorkbenchStatus.WAITING_FOR_APPROVAL;
  const submit = async () => {
    if (active || submitting.current || !draft.trim()) return;
    submitting.current = true;
    setError(undefined);
    const text = draft;
    setDraft('');
    try {
      await actions.send(text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setDraft(current => current || text);
    } finally {
      submitting.current = false;
    }
  };
  return (
    <div class="glyph-composer">
      <div class="glyph-context-chip">
        {selection
          ? `Context: ${selection.path} (${selection.text.length} chars, v${selection.version})`
          : 'No editor selection attached'}
      </div>
      <textarea
        rows={4}
        placeholder="Ask Glyph about this project"
        aria-label="Message Glyph"
        value={draft}
        onInput={event => setDraft(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <button type="button" onClick={() => (active ? actions.cancel() : void submit())}>
        {active ? 'Cancel' : 'Send (⌘/Ctrl+Enter)'}
      </button>
      {error && <div role="alert">{error}</div>}
    </div>
  );
}
