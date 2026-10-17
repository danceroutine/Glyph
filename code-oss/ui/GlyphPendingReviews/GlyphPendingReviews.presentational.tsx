import { ChevronDown, ChevronRight, Check, X, FileCode } from 'lucide-preact';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';
import type { GlyphPendingReviewsState } from './useGlyphPendingReviewsState.ts';

const styles = {
  card: css({
    flexShrink: 0,
    margin: space('none', 'lg'),
    border: tokens.border.default,
    borderRadius: tokens.card.radius,
    background: tokens.surface.pane,
    overflow: 'hidden',
  }),
  header: css({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.space.xxs,
    padding: tokens.space.xs,
  }),
  toggle: css({ marginRight: 'auto', gap: tokens.space.xs }),
  button: css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 24,
    '& svg': { display: 'block', flexShrink: 0 },
    border: 0,
    borderRadius: tokens.button.radius,
    background: 'transparent',
    color: tokens.text.muted,
    font: 'inherit',
    cursor: 'pointer',
    padding: space('xxs', 'xs'),
    ':hover': { background: tokens.button.quiet.hoverBackground },
    ':focus-visible': { outline: tokens.focus.ring },
    ':disabled': { opacity: tokens.opacity.disabled, cursor: 'default' },
  }),
  review: css({ background: tokens.button.secondary.background, color: tokens.button.secondary.foreground }),
  list: css({
    listStyle: 'none',
    margin: 0,
    padding: tokens.space.sm,
    maxHeight: 'min(220px, 25vh)',
    overflowY: 'auto',
  }),
  row: css({
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.xs,
    borderRadius: tokens.list.radius,
    ':hover, :focus-within': { background: tokens.list.hoverBackground, '& .glyph-file-actions': { opacity: 1 } },
  }),
  file: css({
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.sm,
    justifyContent: 'flex-start',
    textAlign: 'left',
    color: tokens.text.primary,
  }),
  name: css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  actions: css({
    display: 'flex',
    opacity: 0,
    '& button': { width: 28, height: 28, padding: 0 },
    '@media (hover: none)': { opacity: 1 },
  }),
  undoAction: css({ '&&:hover:not(:disabled)': { background: 'transparent', color: tokens.diff.removed } }),
  keepAction: css({ '&&:hover:not(:disabled)': { background: 'transparent', color: tokens.diff.added } }),
  added: css({ color: tokens.diff.added, whiteSpace: 'nowrap' }),
  removed: css({ color: tokens.diff.removed, whiteSpace: 'nowrap' }),
  error: css({ color: tokens.text.error, padding: tokens.space.md }),
};

export function GlyphPendingReviews(state: GlyphPendingReviewsState) {
  return (
    <section class={`glyph-pending-reviews ${styles.card}`} aria-label="Pending reviews" aria-busy={state.busy}>
      <header class={styles.header}>
        <button
          class={`${styles.button} ${styles.toggle}`}
          type="button"
          aria-expanded={state.expanded}
          aria-controls={state.expanded ? state.listId : undefined}
          onClick={state.toggle}
        >
          {state.expanded ? (
            <ChevronDown size={16} aria-hidden="true" />
          ) : (
            <ChevronRight size={16} aria-hidden="true" />
          )}
          <span>{state.summary}</span>
        </button>
        <button class={styles.button} type="button" disabled={state.disabled} onClick={state.undo}>
          {state.undoLabel}
        </button>
        <button class={styles.button} type="button" disabled={state.keepDisabled} onClick={state.keep}>
          {state.keepLabel}
        </button>
        <button
          class={`${styles.button} ${styles.review}`}
          type="button"
          disabled={state.disabled}
          onClick={state.review}
        >
          Review
        </button>
      </header>
      {state.expanded && (
        <ul class={styles.list} id={state.listId}>
          {state.files.map(file => (
            <li key={file.key}>
              <div class={styles.row}>
                <button
                  class={`${styles.button} ${styles.file}`}
                  type="button"
                  title={file.path}
                  aria-label={`Review ${file.path}`}
                  disabled={state.disabled}
                  onClick={file.review}
                >
                  <FileCode size={16} aria-hidden="true" />
                  <span class={styles.name}>{file.name}</span>
                  <span class={styles.added}>+{file.additions ?? 0}</span>
                  <span class={styles.removed}>−{file.deletions ?? 0}</span>
                </button>
                <span class={`glyph-file-actions ${styles.actions}`}>
                  <button
                    class={`${styles.button} ${styles.undoAction}`}
                    type="button"
                    aria-label={`Undo ${file.path}`}
                    title="Dismiss proposed changes"
                    disabled={state.disabled}
                    onClick={file.undo}
                  >
                    <X size={20} aria-hidden="true" />
                  </button>
                  <button
                    class={`${styles.button} ${styles.keepAction}`}
                    type="button"
                    aria-label={`Keep ${file.path}`}
                    title="Apply proposed changes"
                    disabled={state.disabled || !file.canKeep}
                    onClick={file.keep}
                  >
                    <Check size={18} aria-hidden="true" />
                  </button>
                </span>
              </div>
              {file.status && (
                <div role="status" class={styles.error}>
                  {file.status}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {state.error && (
        <div class={styles.error} role="alert">
          {state.error}
        </div>
      )}
    </section>
  );
}
