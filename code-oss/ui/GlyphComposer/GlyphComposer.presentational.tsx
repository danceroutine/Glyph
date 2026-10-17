import type { ComponentChildren } from 'preact';
import { FilePlus, RefreshCw, ExternalLink, X } from 'lucide-preact';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';
import type { GlyphComposerState } from './useGlyphComposerState.ts';

const styles = {
  root: css({ padding: tokens.space.md, borderTop: tokens.border.default, position: 'relative' }),
  input: css({
    boxSizing: 'border-box',
    width: '100%',
    color: tokens.input.foreground,
    background: tokens.input.background,
    border: tokens.input.border,
    borderRadius: tokens.card.radius,
    padding: tokens.space.md,
    '& .ProseMirror': {
      color: tokens.input.foreground,
      background: tokens.input.background,
      borderColor: 'transparent',
      outline: 'none',
      minHeight: 80,
      maxHeight: 240,
      overflowY: 'auto',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      font: 'inherit',
    },
    '& .ProseMirror > div:only-child:has(> br:only-child)::before': {
      content: '"Ask Glyph about this project"',
      color: tokens.text.muted,
      pointerEvents: 'none',
      position: 'absolute',
    },
    '& .ProseMirror-selectednode': { outline: tokens.focus.ring },
    ':focus-within': { outline: tokens.focus.ring },
  }),
  button: css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.space.xs,
    font: 'inherit',
    color: tokens.button.secondary.foreground,
    background: tokens.button.secondary.background,
    border: 0,
    borderRadius: tokens.button.radius,
    padding: space('xs', 'sm'),
    cursor: 'pointer',
    ':hover': { background: tokens.button.secondary.hoverBackground },
    ':focus-visible': { outline: tokens.focus.ring },
    ':disabled': { opacity: tokens.opacity.disabled },
  }),
  suggestion: css({
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.xs,
    color: tokens.text.muted,
    fontSize: tokens.font.size.caption,
    marginBottom: tokens.space.sm,
  }),
  footer: css({
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.sm,
    justifyContent: 'space-between',
    marginTop: tokens.space.sm,
  }),
  picker: css({
    position: 'absolute',
    bottom: '100%',
    left: tokens.space.md,
    right: tokens.space.md,
    zIndex: 3,
    maxHeight: 240,
    overflowY: 'auto',
    background: tokens.dropdown.background,
    color: tokens.dropdown.foreground,
    border: tokens.dropdown.border,
    borderRadius: tokens.dropdown.radius,
    padding: tokens.space.xs,
  }),
  option: css({
    display: 'block',
    textAlign: 'left',
    width: '100%',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    '&[aria-selected="true"]': { background: tokens.list.selected.background, color: tokens.list.selected.foreground },
  }),
  preview: css({
    border: tokens.border.default,
    borderRadius: tokens.card.radius,
    padding: tokens.space.md,
    marginBottom: tokens.space.sm,
    '& pre': { maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: tokens.font.family.code },
    '& header': {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: tokens.space.sm,
      overflowWrap: 'anywhere',
    },
  }),
  error: css({ color: tokens.text.error, padding: space('sm', 'none') }),
  unsent: css({
    maxHeight: 160,
    overflowY: 'auto',
    marginBottom: tokens.space.md,
    '& pre': { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' },
  }),
};
export type GlyphComposerProps = GlyphComposerState & { readonly modelControl?: ComponentChildren };
export function GlyphComposer(state: GlyphComposerProps) {
  return (
    <div class={`glyph-composer ${styles.root}`}>
      {state.unsent.length > 0 && (
        <section class={`glyph-unsent ${styles.unsent}`} aria-label="Unsent messages">
          <div>Unsent messages</div>
          {state.unsent.map((text, index) => (
            <div key={index}>
              <pre>{text}</pre>
              <button class={styles.button} type="button" onClick={() => state.editUnsent(index)}>
                Edit unsent message
              </button>
            </div>
          ))}
        </section>
      )}
      {state.preview && (
        <section class={styles.preview} aria-label="Attachment preview">
          <header>
            <strong>
              {state.preview.path}
              {state.preview.range && ` (${state.preview.range.start.line}-${state.preview.range.end.line})`}
              {state.preview.side && ` · ${state.preview.side}`}
            </strong>
            <button
              class={styles.button}
              type="button"
              aria-label="Close attachment preview"
              onClick={state.closePreview}
            >
              <X size={16} />
            </button>
          </header>
          <small>Captured revision {state.preview.contentRevision.slice(0, 12)}</small>
          <pre>{state.preview.text}</pre>
          {state.sourceStatus && <p role="status">{state.sourceStatus}</p>}
          <div class={styles.footer}>
            <button class={styles.button} type="button" disabled={state.pending} onClick={state.openPreview}>
              <ExternalLink size={14} />
              Open source
            </button>
            <button class={styles.button} type="button" disabled={state.pending} onClick={state.refreshPreview}>
              <RefreshCw size={14} />
              Refresh capture
            </button>
            <button class={styles.button} type="button" disabled={state.pending} onClick={state.removePreview}>
              Remove
            </button>
          </div>
        </section>
      )}
      <div class={styles.suggestion}>
        {state.activeContext ? (
          <>
            <span title={state.activeContext.uri}>{state.activeContext.path}</span>
            {state.activeContext.detail ? (
              <span>{state.activeContext.detail}</span>
            ) : (
              <button
                class={styles.button}
                type="button"
                aria-label={`Attach active file ${state.activeContext.path}`}
                disabled={state.pending}
                onClick={state.attachActive}
              >
                <FilePlus size={14} />
                Attach
              </button>
            )}
          </>
        ) : (
          <span>No active text editor</span>
        )}
      </div>
      {state.query && (
        <div id={state.pickerId} class={styles.picker} role="listbox" aria-label="Files to attach">
          {state.searching ? (
            <div role="status">Searching files…</div>
          ) : !state.candidates.length ? (
            <div role="status">No matching files</div>
          ) : (
            state.candidates.map((candidate, index) => (
              <button
                id={`${state.pickerId}-${index}`}
                class={`${styles.button} ${styles.option}`}
                role="option"
                aria-selected={index === state.selected}
                key={candidate.uri}
                type="button"
                disabled={state.pending}
                onMouseDown={event => event.preventDefault()}
                onClick={() => void state.choose(candidate)}
              >
                {candidate.path}
              </button>
            ))
          )}
        </div>
      )}
      <div class={styles.input} ref={state.composer} />
      <div class={styles.footer}>
        {state.modelControl}
        <button
          class={`glyph-send ${styles.button}`}
          type="button"
          disabled={!state.active && state.disabled}
          onClick={state.activate}
        >
          {state.active ? 'Cancel' : 'Send (⌘/Ctrl+Enter)'}
        </button>
      </div>
      {state.error && (
        <div class={styles.error} role="alert">
          {state.error}
        </div>
      )}
    </div>
  );
}
