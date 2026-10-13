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
  const draftRef = useRef('');
  const composer = useRef<HTMLTextAreaElement>(null);
  const [unsent, setUnsent] = useState<readonly string[]>([]);
  const [error, setError] = useState<string>();
  const submitting = useRef(false);
  const active =
    status === GlyphWorkbenchStatus.STREAMING ||
    status === GlyphWorkbenchStatus.WAITING_FOR_QUESTION ||
    status === GlyphWorkbenchStatus.WAITING_FOR_APPROVAL;
  const updateDraft = (text: string) => {
    // Promise settlement must see the latest keystroke even before Preact's
    // next render, otherwise failure recovery can overwrite newer input.
    draftRef.current = text;
    setDraft(text);
  };
  const editUnsent = (index: number) => {
    const text = unsent[index];
    if (text === undefined) return;
    const current = draftRef.current;
    setUnsent(values =>
      values.flatMap((value, position) => {
        if (position !== index) return [value];
        return current ? [current] : [];
      }),
    );
    updateDraft(text);
    composer.current?.focus();
  };
  const submit = async () => {
    if (active || submitting.current || !draftRef.current.trim()) return;
    submitting.current = true;
    setError(undefined);
    const text = draftRef.current;
    updateDraft('');
    try {
      await actions.send(text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      // Never silently merge different messages or discard either draft.
      if (!draftRef.current) updateDraft(text);
      else setUnsent(values => [...values, text]);
    } finally {
      submitting.current = false;
    }
  };
  return (
    <div class="glyph-composer">
      {unsent.length > 0 && (
        <section class="glyph-unsent" aria-label="Unsent messages">
          <div>Unsent messages</div>
          {unsent.map((text, index) => (
            <div key={index}>
              <pre>{text}</pre>
              <button type="button" onClick={() => editUnsent(index)}>
                Edit unsent message
              </button>
            </div>
          ))}
        </section>
      )}
      <div class="glyph-context-chip">
        {selection
          ? `Context: ${selection.path} (${selection.text.length} chars, v${selection.version})`
          : 'No editor selection attached'}
      </div>
      <textarea
        ref={composer}
        rows={4}
        placeholder="Ask Glyph about this project"
        aria-label="Message Glyph"
        value={draft}
        onInput={event => updateDraft(event.currentTarget.value)}
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
