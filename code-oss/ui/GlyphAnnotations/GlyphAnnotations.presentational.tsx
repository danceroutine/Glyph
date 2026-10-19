import { MessageSquareText, ArrowUp, X, Pencil, Trash2 } from 'lucide-preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import type { GlyphAnnotation } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import type { GlyphAnnotationsState } from './useGlyphAnnotationsState.ts';
import { GlyphCommentButton } from './GlyphCommentButton.presentational.tsx';
const styles = {
  button: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.space.xs,
    border: tokens.border.default,
    borderRadius: tokens.button.radius,
    padding: tokens.space.xs,
    font: 'inherit',
    background: tokens.input.background,
    color: tokens.text.primary,
    cursor: 'pointer',
    ':focus-visible': { outline: tokens.focus.ring },
  }),
  editor: css({
    position: 'fixed',
    zIndex: 1001,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.md,
    boxSizing: 'border-box',
    width: 340,
    maxWidth: '90vw',
    padding: tokens.space.md,
    border: tokens.border.default,
    borderRadius: 24,
    background: tokens.input.background,
    color: tokens.text.primary,
    '& textarea': {
      width: '100%',
      boxSizing: 'border-box',
      minWidth: 0,
      flex: 1,
      minHeight: 28,
      maxHeight: 160,
      fieldSizing: 'content',
      padding: '4px 8px',
      lineHeight: 1.5,
      resize: 'none',
      font: 'inherit',
      color: 'inherit',
      background: 'transparent',
      border: 0,
      outline: 'none',
      ':focus-visible': { outline: 'none' },
    },

    '& footer': { display: 'flex', flexShrink: 0 },
    '& button': {
      width: 30,
      height: 30,
      padding: 0,
      justifyContent: 'center',
      borderRadius: tokens.avatar.radius,
      background: tokens.text.primary,
      color: tokens.surface.canvas,
    },
    '& button:disabled': { opacity: tokens.opacity.disabled },
  }),
  pill: css({
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    maxWidth: '100%',
    marginBottom: tokens.space.sm,
    border: tokens.border.default,
    borderRadius: tokens.card.radius,
    color: tokens.text.primary,
    background: tokens.surface.canvas,
    '&:hover > section, &:focus-within > section': { display: 'block' },
    '&:hover .glyph-annotation-clear, &:focus-within .glyph-annotation-clear': { opacity: 1, pointerEvents: 'auto' },
  }),
  pillLabel: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.space.sm,
    minWidth: 0,
    padding: tokens.space.md,
    border: 0,
    borderRadius: tokens.card.radius,
    font: 'inherit',
    color: 'inherit',
    background: 'transparent',
    cursor: 'pointer',
    ':focus-visible': { outline: tokens.focus.ring },
    '& svg': { flexShrink: 0, color: tokens.text.muted },
    '& span': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  }),
  icon: css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: 26,
    height: 26,
    padding: 0,
    border: 0,
    color: tokens.text.muted,
    background: 'transparent',
    cursor: 'pointer',
    ':hover': { color: tokens.text.primary },
    ':focus-visible': { outline: tokens.focus.ring },
  }),
  clear: css({
    position: 'absolute',
    right: tokens.space.xs,
    top: '50%',
    transform: 'translateY(-50%)',
    opacity: 0,
    pointerEvents: 'none',
    background: tokens.surface.canvas,
    boxShadow: `-8px 0 6px ${tokens.surface.canvas}`,
    border: tokens.border.default,
    borderRadius: tokens.avatar.radius,
  }),
  list: css({
    display: 'none',
    position: 'absolute',
    bottom: '100%',
    left: 0,
    zIndex: 10,
    boxSizing: 'border-box',
    width: 380,
    maxWidth: 'min(calc(100vw - 32px), calc(100cqw - 32px))',
    maxHeight: 350,
    overflow: 'auto',
    background: tokens.dropdown.background,
    color: tokens.text.primary,
    border: tokens.border.default,
    borderRadius: tokens.card.radius,
    padding: tokens.space.lg,
  }),
  item: css({
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: '18px minmax(0, 1fr)',
    gap: tokens.space.sm,
    padding: tokens.space.xs,
    '& + article': { marginTop: tokens.space.lg, paddingTop: tokens.space.lg, borderTop: tokens.border.default },
  }),
  order: css({ color: tokens.text.muted, lineHeight: tokens.font.lineHeight.normal }),
  details: css({
    margin: 0,
    minWidth: 0,
    lineHeight: tokens.font.lineHeight.normal,
    '& dt': { color: tokens.text.muted },
    '& dt:first-child': { paddingRight: 64 },
    '& dd': { margin: 0, marginTop: tokens.space.xs, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
    '& dd + dt': { marginTop: tokens.space.md },
  }),
  actions: css({
    position: 'absolute',
    top: tokens.space.xs,
    right: tokens.space.xs,
    display: 'flex',
    gap: tokens.space.xs,
  }),
};
export function GlyphAnnotationPill({
  annotations,
  edit,
  remove,
}: {
  readonly annotations: readonly GlyphAnnotation[];
  readonly edit?: (id: string) => void;
  readonly remove?: (id: string) => void;
}) {
  if (!annotations.length) return null;
  return (
    <div class={`glyph-annotation-pill ${styles.pill}`}>
      <button
        type="button"
        class={styles.pillLabel}
        aria-label={`${annotations.length} ${annotations.length === 1 ? 'annotation' : 'annotations'}`}
      >
        <MessageSquareText size={16} aria-hidden="true" />
        <span>
          {annotations.length} {annotations.length === 1 ? 'annotation' : 'annotations'}
        </span>
      </button>
      {remove && (
        <button
          type="button"
          class={`glyph-annotation-clear ${styles.icon} ${styles.clear}`}
          aria-label="Remove all annotations"
          onClick={() => annotations.forEach(annotation => remove(annotation.id))}
        >
          <X size={16} aria-hidden="true" />
        </button>
      )}
      <section class={styles.list} aria-label="Annotations">
        {annotations.map(annotation => (
          <article
            key={annotation.id}
            class={styles.item}
            aria-label={`Annotation ${annotation.order}: ${annotation.label}`}
          >
            <span class={styles.order}>{annotation.order}.</span>
            <dl class={styles.details}>
              <dt>Selected text:</dt>
              <dd>{annotation.quote}</dd>
              <dt>User comment:</dt>
              <dd>{annotation.comment}</dd>
            </dl>
            <div class={styles.actions}>
              {edit && (
                <button
                  type="button"
                  class={styles.icon}
                  aria-label={`Edit annotation ${annotation.order}`}
                  onClick={() => edit(annotation.id)}
                >
                  <Pencil size={18} aria-hidden="true" />
                </button>
              )}
              {remove && (
                <button
                  type="button"
                  class={styles.icon}
                  aria-label={`Delete annotation ${annotation.order}`}
                  onClick={() => remove(annotation.id)}
                >
                  <Trash2 size={18} aria-hidden="true" />
                </button>
              )}
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
export function GlyphAnnotations(state: GlyphAnnotationsState) {
  return (
    <>
      {state.markers.map(({ annotation, x, y }) => (
        <GlyphCommentButton
          key={annotation.id}
          position={{ x, y }}
          order={annotation.order}
          open={() => state.edit(annotation.id)}
        />
      ))}
      {state.candidate && <GlyphCommentButton position={state.candidate} open={state.open} />}
      {state.draft && (
        <form
          class={styles.editor}
          aria-label="Annotation editor"
          ref={state.editor}
          style={{
            left: `${state.editorPosition.x}px`,
            top: `${state.editorPosition.y}px`,
          }}
          onSubmit={event => {
            event.preventDefault();
            state.submit();
          }}
        >
          <textarea
            aria-label="Annotation comment"
            aria-description={`Comment on: ${state.draft.annotation.quote}`}
            title="Enter to save; Shift+Enter for a new line; Escape to cancel"
            placeholder="Add a comment…"
            rows={1}
            ref={state.textarea}
            value={state.comment}
            maxLength={10000}
            onInput={event => state.setComment(event.currentTarget.value)}
            onKeyDown={event => {
              event.stopPropagation();
              if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                state.submit();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                state.close();
              }
            }}
          />
          <footer>
            <button
              type="submit"
              class={styles.button}
              aria-label="Save annotation"
              disabled={!state.comment.trim() || state.disabled}
            >
              <ArrowUp size={16} />
            </button>
          </footer>
        </form>
      )}
    </>
  );
}
