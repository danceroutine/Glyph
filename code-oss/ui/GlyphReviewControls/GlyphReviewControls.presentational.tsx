import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, MessageSquare } from 'lucide-preact';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';
import type { GlyphReviewControlsState } from './useGlyphReviewControlsState.ts';
const styles = {
  root: css({
    boxSizing: 'border-box',
    background: tokens.surface.canvas,
    color: tokens.text.primary,
    border: tokens.border.default,
    borderRadius: tokens.button.radius,
    padding: tokens.space.xs,
    fontFamily: tokens.font.family.body,
    fontSize: tokens.font.size.body,
    maxWidth: '100%',
  }),
  bar: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: tokens.space.xs,
    flexWrap: 'wrap',
  }),
  button: css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 24,
    gap: tokens.space.xs,
    '& svg': { display: 'block', flexShrink: 0 },
    background: tokens.button.secondary.background,
    color: tokens.button.secondary.foreground,
    border: 0,
    borderRadius: tokens.button.radius,
    font: 'inherit',
    padding: space('xs', 'sm'),
    cursor: 'pointer',
    ':hover': { background: tokens.button.secondary.hoverBackground },
    ':focus-visible': { outline: tokens.focus.ring },
    ':disabled': { opacity: tokens.opacity.disabled },
  }),
  commentButton: css({
    background: tokens.button.background,
    color: tokens.button.foreground,
    ':hover': { background: tokens.button.hoverBackground },
  }),
  keep: css({
    background: tokens.review.keepBackground,
    color: tokens.review.keepForeground,
    ':hover': { background: tokens.review.keepBackground },
  }),
  shortcut: css({ font: 'inherit', color: 'inherit' }),
  commentForm: css({ display: 'flex', flexDirection: 'column', gap: tokens.space.sm, padding: tokens.space.sm }),
  commentInput: css({
    background: tokens.input.background,
    color: tokens.input.foreground,
    border: tokens.input.border,
    borderRadius: tokens.button.radius,
    font: 'inherit',
    padding: tokens.space.sm,
    resize: 'vertical',
    minHeight: 60,
    ':focus-visible': { outline: tokens.focus.ring },
  }),
  error: css({ color: tokens.text.error, whiteSpace: 'normal', maxWidth: 500, padding: tokens.space.sm }),
};
export function GlyphReviewControls(state: GlyphReviewControlsState) {
  return (
    <section class={styles.root} aria-label={state.fileLabel ? 'File review controls' : 'Edit review controls'}>
      <div class={styles.bar}>
        <button
          class={styles.button}
          type="button"
          aria-label="Previous change"
          disabled={state.disabled}
          onClick={state.previous}
        >
          <ChevronUp size={16} aria-hidden="true" />
        </button>
        <span>{state.label}</span>
        <button
          class={styles.button}
          type="button"
          aria-label="Next change"
          disabled={state.disabled}
          onClick={state.next}
        >
          <ChevronDown size={16} aria-hidden="true" />
        </button>
        {state.previousFile && (
          <button
            class={styles.button}
            type="button"
            aria-label="Previous file"
            disabled={state.navigationDisabled}
            onClick={state.previousFile}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
        )}
        {state.fileLabel && <span>{state.fileLabel}</span>}
        {state.nextFile && (
          <button
            class={styles.button}
            type="button"
            aria-label="Review Next File"
            disabled={state.navigationDisabled}
            onClick={state.nextFile}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        )}
        {!state.fileLabel && (
          <button
            class={styles.button}
            type="button"
            aria-label="Undo"
            aria-keyshortcuts={state.shortcutModifier === '⌘' ? 'Meta+N' : 'Control+N'}
            disabled={state.disabled}
            onClick={state.undo}
          >
            Undo {state.shortcutModifier && <kbd class={styles.shortcut}>{state.shortcutModifier}N</kbd>}
          </button>
        )}
        {!state.fileLabel && (
          <button
            class={`${styles.button} ${styles.keep}`}
            type="button"
            aria-label="Keep"
            aria-keyshortcuts={state.shortcutModifier === '⌘' ? 'Meta+Y' : 'Control+Y'}
            disabled={state.keepDisabled}
            onClick={state.keep}
          >
            Keep {state.shortcutModifier && <kbd class={styles.shortcut}>{state.shortcutModifier}Y</kbd>}
          </button>
        )}
        {!state.fileLabel && state.rejectWithComment && (
          <button
            class={`${styles.button} ${styles.commentButton}`}
            type="button"
            aria-label="Reject with comments"
            aria-keyshortcuts={state.shortcutModifier === '⌘' ? 'Meta+R' : 'Control+R'}
            title={`Reject with comments${state.shortcutModifier ? ` (${state.shortcutModifier}R)` : ''}`}
            disabled={state.disabled}
            onClick={state.openComment}
          >
            <MessageSquare size={16} aria-hidden="true" />
            {state.shortcutModifier && <kbd class={styles.shortcut}>{state.shortcutModifier}R</kbd>}
          </button>
        )}
        {state.undoFile && (
          <button class={styles.button} type="button" disabled={state.disabled} onClick={state.undoFile}>
            Undo File
          </button>
        )}
        {state.keepFile && (
          <button
            class={`${styles.button} ${styles.keep}`}
            type="button"
            disabled={state.keepDisabled}
            onClick={state.keepFile}
          >
            Keep File
          </button>
        )}
        {state.keepAll && (
          <button class={styles.button} type="button" disabled={state.keepAllDisabled} onClick={state.keepAll}>
            Keep all changes
          </button>
        )}
      </div>
      {state.commentOpen && (
        <form
          class={styles.commentForm}
          aria-label="Rejection comment"
          onSubmit={event => {
            event.preventDefault();
            void state.submitComment();
          }}
        >
          <label htmlFor="glyph-review-comment">Why should this change be revised?</label>
          <textarea
            id="glyph-review-comment"
            ref={state.commentInput}
            class={styles.commentInput}
            value={state.comment}
            maxLength={4000}
            disabled={state.commentPending}
            onInput={event => state.setComment(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                state.cancelComment();
              }
            }}
          />
          <div class={styles.bar}>
            <button class={styles.button} type="button" disabled={state.commentPending} onClick={state.cancelComment}>
              Cancel
            </button>
            <button class={`${styles.button} ${styles.commentButton}`} type="submit" disabled={state.commentDisabled}>
              Reject with comment
            </button>
          </div>
        </form>
      )}
      {state.error && (
        <div class={styles.error} role="alert">
          {state.error}
        </div>
      )}
    </section>
  );
}
