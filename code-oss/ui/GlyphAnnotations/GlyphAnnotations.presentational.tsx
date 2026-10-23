import {
  IconButton,
  ButtonSize,
  ButtonVariant,
  ButtonAppearance,
  IconButtonShape,
  Button,
} from '#code-oss/ui/Button/Button.tsx';
import { createPortal } from 'preact/compat';
import { MessageSquareText, ArrowUp, X, Pencil, Trash2 } from 'lucide-preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import type { GlyphAnnotation } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import type { GlyphAnnotationsState } from './useGlyphAnnotationsState.ts';
import { GlyphCommentButton } from './GlyphCommentButton.presentational.tsx';
const styles = {
  closePosition: css({ position: 'absolute', top: 10, right: 10 }),

  editor: css({
    position: 'fixed',
    zIndex: 1001,
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    width: 440,
    maxWidth: '90vw',
    padding: 12,
    gap: 8,
    border: tokens.input.strongBorder,
    borderRadius: 8,
    background: tokens.surface.canvas,
    color: tokens.text.primary,
    fontFamily: tokens.font.family.body,
    fontSize: tokens.font.size.body,
    '& textarea': {
      width: '100%',
      boxSizing: 'border-box',
      minWidth: 0,
      minHeight: 48,
      maxHeight: 200,
      fieldSizing: 'content',
      padding: '4px 30px 4px 4px',
      lineHeight: 1.5,
      resize: 'none',
      font: 'inherit',
      color: 'inherit',
      background: 'transparent',
      border: 0,
      outline: 'none',
      ':focus-visible': { outline: 'none' },
    },
    '& footer': { display: 'flex', justifyContent: 'flex-end' },
  }),
  inlineEditor: css({ '&&': { position: 'relative', width: '100%', maxWidth: 'none' } }),

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
    '&&': {
      gap: tokens.space.sm,
      minWidth: 0,
      flexShrink: 1,
      padding: tokens.space.md,
      border: 0,
      borderRadius: tokens.card.radius,
      color: 'inherit',
    },
    '& svg': { color: tokens.text.muted },
    '& span': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  }),

  clear: css({
    // Keep a dedicated slot so revealing the action never covers the label or resizes the pill.
    marginRight: tokens.space.xs,
    opacity: 0,
    pointerEvents: 'none',
    '@media (hover: none)': { opacity: 1, pointerEvents: 'auto' },
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
  if (annotations.length === 0) return null;
  return (
    <div class={`glyph-annotation-pill ${styles.pill}`}>
      <Button
        appearance={ButtonAppearance.GHOST}
        type="button"
        class={styles.pillLabel}
        aria-label={`${annotations.length} ${annotations.length === 1 ? 'annotation' : 'annotations'}`}
      >
        <MessageSquareText size={16} aria-hidden="true" />
        <span>
          {annotations.length} {annotations.length === 1 ? 'annotation' : 'annotations'}
        </span>
      </Button>
      {remove && (
        <IconButton
          size={ButtonSize.SMALL}
          type="button"
          shape={IconButtonShape.CIRCLE}
          class={`glyph-annotation-clear ${styles.clear}`}
          aria-label="Remove all annotations"
          onClick={() => {
            annotations.forEach(annotation => {
              remove(annotation.id);
            });
          }}
        >
          <X size={16} aria-hidden="true" />
        </IconButton>
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
                <IconButton
                  size={ButtonSize.SMALL}
                  type="button"

                  aria-label={`Edit annotation ${annotation.order}`}
                  onClick={() => {
                    edit(annotation.id);
                  }}
                >
                  <Pencil size={18} aria-hidden="true" />
                </IconButton>
              )}
              {remove && (
                <IconButton
                  size={ButtonSize.SMALL}
                  type="button"

                  aria-label={`Delete annotation ${annotation.order}`}
                  onClick={() => {
                    remove(annotation.id);
                  }}
                >
                  <Trash2 size={18} aria-hidden="true" />
                </IconButton>
              )}
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
export function GlyphAnnotations(
  state: GlyphAnnotationsState & {
    readonly selectionShortcut?: string;
    readonly hideMarkers?: boolean;
    readonly editorContainer?: HTMLElement;
  },
) {
  const container = state.editorContainer ?? state.draft?.container;
  const form = state.draft && (
    <form
      class={`${styles.editor} ${container ? styles.inlineEditor : ''}`}
      aria-label="Annotation editor"
      ref={state.editor}
      style={
        container
          ? undefined
          : {
              left: `${state.editorPosition.x}px`,
              top: `${state.editorPosition.y}px`,
            }
      }
      onSubmit={event => {
        event.preventDefault();
        state.submit();
      }}
    >
      <IconButton
        size={ButtonSize.SMALL}
        type="button"
        class={styles.closePosition}
        aria-label="Cancel annotation"
        onClick={state.close}
      >
        <X size={16} aria-hidden="true" />
      </IconButton>
      <textarea
        aria-label="Annotation comment"
        aria-description={`Comment on: ${state.draft.annotation.quote}`}
        title="Enter to save; Shift+Enter for a new line; Escape to cancel"
        placeholder="Add a comment…"
        rows={2}
        ref={state.textarea}
        value={state.comment}
        maxLength={10000}
        onInput={event => {
          state.setComment(event.currentTarget.value);
        }}
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
        <IconButton
          variant={ButtonVariant.PRIMARY}
          appearance={ButtonAppearance.FILLED}
          shape={IconButtonShape.CIRCLE}
          type="submit"

          aria-label="Save annotation"
          disabled={!state.comment.trim() || state.disabled}
        >
          <ArrowUp size={16} />
        </IconButton>
      </footer>
    </form>
  );
  return (
    <>
      {state.hideMarkers !== true &&
        state.markers.map(({ annotation, x, y }) => (
          <GlyphCommentButton
            key={annotation.id}
            position={{ x, y }}
            order={annotation.order}
            open={() => {
              state.edit(annotation.id);
            }}
          />
        ))}
      {state.candidate && (
        <GlyphCommentButton
          position={state.candidate}
          open={state.open}
          {...(state.selectionShortcut !== undefined && state.selectionShortcut !== ''
            ? { shortcut: state.selectionShortcut }
            : {})}
        />
      )}
      {form && (container ? createPortal(form, container) : form)}
    </>
  );
}
