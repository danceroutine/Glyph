import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchSelection } from '#src/desktop/workbench/GlyphWorkbenchSelection.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { css } from './emotion.ts';

const styles = {
  root: css({
    padding: 8,
    borderTop: '1px solid var(--vscode-panel-border)',
    '& button': { marginTop: 8 },
  }),
  unsent: css({
    maxHeight: 160,
    overflowY: 'auto',
    marginBottom: 8,
    '& pre': { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' },
  }),
  context: css({
    color: 'var(--vscode-descriptionForeground)',
    fontSize: 11,
    marginBottom: 6,
  }),
  input: css({
    boxSizing: 'border-box',
    width: '100%',
    resize: 'vertical',
    color: 'var(--vscode-input-foreground)',
    background: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border, transparent)',
  }),
};

interface GlyphComposerProps {
  readonly status: GlyphWorkbenchStatus;
  readonly selection: GlyphWorkbenchSelection | undefined;
  readonly actions: GlyphWorkbenchViewActions;
}

/** Renders the window-owned draft without tying its lifetime to the pane. */
export function GlyphComposer({ status, selection, actions }: GlyphComposerProps) {
  const model = actions.composer;
  const [state, setState] = useState(model.snapshot);
  useLayoutEffect(() => {
    const refresh = () => setState(model.snapshot);
    const stop = model.subscribe(refresh);
    refresh();
    return stop;
  }, [model]);
  const { draft, unsent, error } = state;
  const composer = useRef<HTMLTextAreaElement>(null);
  const active =
    status === GlyphWorkbenchStatus.STREAMING ||
    status === GlyphWorkbenchStatus.WAITING_FOR_QUESTION ||
    status === GlyphWorkbenchStatus.WAITING_FOR_APPROVAL;
  const updateDraft = (text: string) => {
    model.setDraft(text);
  };
  const editUnsent = (index: number) => {
    model.editUnsent(index);
    composer.current?.focus();
  };
  const submit = async () => {
    if (!active) await model.submit(text => actions.send(text));
  };
  return (
    <div class={`glyph-composer ${styles.root}`}>
      {unsent.length > 0 && (
        <section class={`glyph-unsent ${styles.unsent}`} aria-label="Unsent messages">
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
      <div class={`glyph-context-chip ${styles.context}`}>
        {selection
          ? `Context: ${selection.path} (${selection.text.length} chars, v${selection.version})`
          : 'No editor selection attached'}
      </div>
      <textarea
        class={styles.input}
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
