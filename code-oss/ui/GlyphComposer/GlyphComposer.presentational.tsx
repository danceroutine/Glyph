import { GlyphAnnotationPill } from '#code-oss/ui/GlyphAnnotations/GlyphAnnotations.presentational.tsx';
import type { ComponentChildren } from 'preact';
import { RefreshCw, ExternalLink, X, Paperclip, ArrowUp, Square } from 'lucide-preact';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';
import type { GlyphComposerState } from './useGlyphComposerState.ts';

const styles = {
  root: css({ padding: tokens.space.md, position: 'relative' }),
  annotations: css({ padding: '10px 10px 0' }),
  surface: css({
    border: tokens.input.strongBorder,
    borderRadius: tokens.card.radius,
    background: tokens.input.background,
    color: tokens.input.foreground,
  }),
  controls: css({ display: 'flex', alignItems: 'center', gap: tokens.space.sm, flex: 1, minWidth: 0 }),
  actions: css({ display: 'flex', alignItems: 'center', gap: tokens.space.sm, flexShrink: 0 }),
  icon: css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    flexShrink: 0,
    padding: 0,
    border: 0,
    background: 'transparent',
    color: tokens.text.muted,
    cursor: 'pointer',
    ':focus-visible': { outline: tokens.focus.ring },
    ':hover': { color: tokens.text.primary },
    ':disabled': { opacity: tokens.opacity.disabled, cursor: 'default' },
  }),
  send: css({
    borderRadius: '50%',
    background: tokens.text.primary,
    color: tokens.input.background,
    ':hover': { background: tokens.text.primary, color: tokens.input.background },
  }),
  hidden: css({
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  }),
  input: css({
    boxSizing: 'border-box',
    width: '100%',
    color: tokens.input.foreground,
    background: 'transparent',
    padding: space('lg', 'lg', 'xs'),
    '& .ProseMirror': {
      color: tokens.input.foreground,
      background: 'transparent',
      borderColor: 'transparent',
      outline: 'none',
      minHeight: 48,
      maxHeight: 240,
      overflowY: 'auto',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      font: 'inherit',
    },
    '& .ProseMirror > p:only-child:has(> br:only-child)::before': {
      content: '"Plan, build, @ for context"',
      color: tokens.input.placeholder,
      pointerEvents: 'none',
      position: 'absolute',
    },
    '& .ProseMirror p': { margin: '0 0 6px' },
    '& .ProseMirror > :last-child': { marginBottom: 0 },
    '& .ProseMirror ul, & .ProseMirror ol': { margin: '4px 0', paddingLeft: 24 },
    '& .ProseMirror li > p': { margin: 0 },
    '& .ProseMirror blockquote': {
      margin: '6px 0',
      paddingLeft: 12,
      borderLeft: `2px solid ${tokens.text.muted}`,
      color: tokens.text.muted,
    },
    '& .ProseMirror h1, & .ProseMirror h2, & .ProseMirror h3': { fontSize: '1.15em', margin: '8px 0' },
    '& .ProseMirror pre': {
      whiteSpace: 'pre-wrap',
      fontFamily: tokens.font.family.code,
      padding: 8,
      background: tokens.surface.canvas,
    },
    '& .ProseMirror code': { fontFamily: tokens.font.family.code },
    '& .glyph-prompt-link': { color: tokens.context.file.foreground },
    '& .ProseMirror-selectednode': { outline: tokens.focus.ring },
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
  footer: css({
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.sm,
    justifyContent: 'space-between',
    padding: space('sm', 'lg', 'lg'),
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
export type GlyphComposerProps = GlyphComposerState & {
  readonly modelControl?: ComponentChildren;
  readonly modeControl: ComponentChildren;
};
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
      <div class={`glyph-composer-surface ${styles.surface}`}>
        {state.annotations.length > 0 && (
          <div class={styles.annotations}>
            <GlyphAnnotationPill
              annotations={state.annotations}
              edit={state.editAnnotation}
              remove={state.removeAnnotation}
            />
          </div>
        )}
        <div class={styles.input} ref={state.composer} />
        <div class={styles.footer}>
          <div class={styles.controls}>
            {state.modeControl}
            {state.modelControl}
          </div>
          <div class={styles.actions}>
            <button
              class={styles.icon}
              type="button"
              title="Attach file"
              aria-label="Attach file"
              disabled={state.pending || state.disabled}
              onMouseDown={event => event.preventDefault()}
              onClick={state.attachFile}
            >
              <Paperclip size={18} aria-hidden="true" />
            </button>
            <button
              class={`glyph-send ${styles.icon} ${styles.send}`}
              style={
                state.mode === 'plan' ? { background: tokens.text.warning, color: tokens.surface.canvas } : undefined
              }
              type="button"
              disabled={!state.active && state.disabled}
              onClick={state.activate}
              title={state.active ? 'Cancel' : 'Send (⌘/Ctrl+Enter)'}
            >
              {state.active ? (
                <Square size={13} fill="currentColor" aria-hidden="true" />
              ) : (
                <ArrowUp size={18} aria-hidden="true" />
              )}
              <span class={styles.hidden}>{state.active ? 'Cancel' : 'Send (⌘/Ctrl+Enter)'}</span>
            </button>
          </div>
        </div>
      </div>
      {state.error && (
        <div class={styles.error} role="alert">
          {state.error}
        </div>
      )}
    </div>
  );
}
