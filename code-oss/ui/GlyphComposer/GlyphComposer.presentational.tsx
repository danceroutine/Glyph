import type { GlyphComposerState } from './useGlyphComposerState.ts';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import type { ComponentChildren } from 'preact';

const styles = {
  root: css({
    padding: tokens.space.md,
    borderTop: tokens.border.default,
    '& button': { marginTop: tokens.space.md },
  }),
  unsent: css({
    maxHeight: 160,
    overflowY: 'auto',
    marginBottom: tokens.space.md,
    '& pre': { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' },
  }),
  context: css({
    color: tokens.text.muted,
    fontSize: tokens.font.size.caption,
    marginBottom: tokens.space.sm,
  }),
  input: css({
    boxSizing: 'border-box',
    width: '100%',
    resize: 'vertical',
    color: tokens.input.foreground,
    background: tokens.input.background,
    border: tokens.input.border,
  }),
};

export type GlyphComposerProps = GlyphComposerState & { readonly modelControl?: ComponentChildren };

export function GlyphComposer({
  draft,
  unsent,
  error,
  composer,
  active,
  disabled,
  updateDraft,
  editUnsent,
  submit,
  context,
  activate,
  modelControl,
}: GlyphComposerProps) {
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
      <div class={`glyph-context-chip ${styles.context}`}>{context}</div>
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
      {modelControl}
      <button type="button" disabled={!active && disabled} onClick={activate}>
        {active ? 'Cancel' : 'Send (⌘/Ctrl+Enter)'}
      </button>
      {error && <div role="alert">{error}</div>}
    </div>
  );
}
