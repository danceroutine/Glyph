import { GlyphContextPicker } from '#code-oss/ui/GlyphContextPicker/GlyphContextPicker.tsx';
import { Button, IconButton, ButtonVariant, ButtonAppearance, IconButtonShape } from '#code-oss/ui/Button/Button.tsx';
import { glyphSyntaxStyles } from '#code-oss/ui/GlyphSyntaxHighlighting/GlyphSyntaxStyles.ts';
import { GlyphQueuedMessages } from '#code-oss/ui/GlyphQueuedMessages/GlyphQueuedMessages.tsx';
import { GlyphAnnotationPill } from '#code-oss/ui/GlyphAnnotations/GlyphAnnotations.presentational.tsx';
import type { ComponentChildren } from 'preact';
import { RefreshCw, ExternalLink, X, Paperclip, ArrowUp, Square } from 'lucide-preact';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';
import type { GlyphComposerState } from './useGlyphComposerState.ts';

const styles = {
  root: css({ padding: tokens.space.md, position: 'relative', flexShrink: 0 }),
  annotations: css({ padding: '10px 10px 0' }),
  surface: css({
    position: 'relative',
    border: tokens.input.strongBorder,
    borderRadius: tokens.card.radius,
    background: tokens.input.background,
    color: tokens.input.foreground,
  }),
  queueEditHeader: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '8px 12px',
    borderRadius: `${tokens.card.radius}px ${tokens.card.radius}px 0 0`,
    borderBottom: tokens.input.strongBorder,
    background: `color-mix(in srgb, ${tokens.focus.color} 24%, ${tokens.input.background})`,
  }),
  cancelQueueEdit: css({
    '&&': { paddingInline: 6, color: tokens.context.file.foreground },
  }),
  controls: css({ display: 'flex', alignItems: 'center', gap: tokens.space.sm, flex: 1, minWidth: 0 }),
  actions: css({ display: 'flex', alignItems: 'center', gap: tokens.space.sm, flexShrink: 0 }),

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
      content: '"Plan, build, / for rules, @ for context"',
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
  footer: css({
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.sm,
    justifyContent: 'space-between',
    padding: space('sm', 'lg', 'lg'),
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
  readonly goal?: ComponentChildren;
  readonly todos?: ComponentChildren;
  readonly terminals?: ComponentChildren;
  readonly reviews?: ComponentChildren;
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
              <Button
                type="button"
                onClick={() => {
                  state.editUnsent(index);
                }}
              >
                Edit unsent message
              </Button>
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
            <IconButton aria-label="Close attachment preview" onClick={state.closePreview}>
              <X size={16} />
            </IconButton>
          </header>
          <small>Captured revision {state.preview.contentRevision.slice(0, 12)}</small>
          <pre>{state.preview.text}</pre>
          {state.sourceStatus !== undefined && state.sourceStatus !== '' && <p role="status">{state.sourceStatus}</p>}
          <div class={styles.footer}>
            <Button
              type="button"
              disabled={state.pending}
              onClick={() => {
                void state.openPreview();
              }}
            >
              <ExternalLink size={14} />
              Open source
            </Button>
            {['file', 'selection', 'folder'].includes(state.preview.kind) && (
              <Button
                type="button"
                disabled={state.pending}
                onClick={() => {
                  void state.refreshPreview();
                }}
              >
                <RefreshCw size={14} />
                Refresh capture
              </Button>
            )}
            <Button type="button" disabled={state.pending} onClick={state.removePreview}>
              Remove
            </Button>
          </div>
        </section>
      )}
      {state.goal}
      {state.todos}
      {state.reviews}
      {state.terminals}
      <GlyphQueuedMessages state={state} />
      <div class={`glyph-composer-surface ${styles.surface}`}>
        {state.query && (
          <GlyphContextPicker
            id={state.pickerId}
            mode={state.query.trigger === '/' ? 'rules' : 'context'}
            candidates={state.candidates}
            selected={state.selected}
            searching={state.searching}
            disabled={state.pending}
            highlight={state.highlightCandidate}
            choose={candidate => void state.choose(candidate)}
          />
        )}
        {state.editingQueuedMessage !== undefined && state.editingQueuedMessage !== '' && (
          <div class={styles.queueEditHeader}>
            <span>Editing queued message</span>
            <Button
              appearance={ButtonAppearance.GHOST}
              class={styles.cancelQueueEdit}
              type="button"
              aria-label="Cancel queue edit"
              onClick={state.cancelQueueEdit}
            >
              Cancel
            </Button>
          </div>
        )}
        {state.annotations.length > 0 && (
          <div class={styles.annotations}>
            <GlyphAnnotationPill
              annotations={state.annotations}
              edit={state.editAnnotation}
              remove={state.removeAnnotation}
            />
          </div>
        )}
        <div class={`${styles.input} ${glyphSyntaxStyles}`} ref={state.composer} />
        <div class={styles.footer}>
          <div class={styles.controls}>
            {state.modeControl}
            {state.modelControl}
          </div>
          <div class={styles.actions}>
            <IconButton
              type="button"
              shape={IconButtonShape.CIRCLE}
              title="Attach file"
              aria-label="Attach file"
              disabled={state.pending || state.disabled}
              onMouseDown={event => {
                event.preventDefault();
              }}
              onClick={() => {
                void state.attachFile();
              }}
            >
              <Paperclip size={18} aria-hidden="true" />
            </IconButton>
            {state.active && state.editingQueuedMessage === undefined && state.draft.trim() && (
              <IconButton
                type="button"
                shape={IconButtonShape.CIRCLE}
                title="Cancel"
                aria-label="Cancel"
                disabled={state.disabled}
                onClick={state.cancel}
              >
                <Square size={13} style={{ width: 13, height: 13 }} aria-hidden="true" />
              </IconButton>
            )}
            <IconButton
              variant={ButtonVariant.PRIMARY}
              mode={state.mode}
              shape={IconButtonShape.CIRCLE}
              appearance={ButtonAppearance.FILLED}
              aria-label={state.saveQueueLabel ?? (state.active ? 'Cancel' : state.sendLabel)}
              class={'glyph-send'}

              type="button"
              disabled={
                state.disabled || state.submitting || (state.editingQueuedMessage !== undefined && !state.draft.trim())
              }
              onClick={state.activate}
              title={state.saveQueueLabel ?? (state.active ? 'Cancel' : state.sendLabel)}
            >
              {state.active && state.editingQueuedMessage === undefined && !state.draft.trim() ? (
                <Square size={13} style={{ width: 13, height: 13 }} fill="currentColor" aria-hidden="true" />
              ) : (
                <ArrowUp size={18} aria-hidden="true" />
              )}
              <span class={styles.hidden}>{state.saveQueueLabel ?? (state.active ? 'Cancel' : state.sendLabel)}</span>
            </IconButton>
          </div>
        </div>
      </div>
      {state.error !== undefined && state.error !== '' && (
        <div class={styles.error} role="alert">
          {state.error}
        </div>
      )}
    </div>
  );
}
