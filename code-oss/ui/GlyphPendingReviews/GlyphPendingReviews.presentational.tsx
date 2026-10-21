import { GlyphRenameBadge } from '#code-oss/ui/GlyphFileIcon/GlyphRenameBadge.tsx';
import { GlyphFileIcon } from '#code-oss/ui/GlyphFileIcon/GlyphFileIcon.tsx';
import { Button, ButtonSize, ButtonAppearance, IconButton } from '#code-oss/ui/Button/Button.tsx';
import { composerDrawerStyles as drawer } from '#code-oss/ui/GlyphComposer/GlyphComposerDrawer.styles.ts';
import { ChevronUp, Check, X, Undo2 } from 'lucide-preact';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';
import type { GlyphPendingReviewsState } from './useGlyphPendingReviewsState.ts';

const styles = {
  card: css({ overflow: 'hidden' }),
  header: css({ flexWrap: 'wrap' }),
  headerActions: css({ display: 'inline-flex', gap: tokens.space.xxs, marginLeft: 'auto' }),
  count: css({
    '&&': {
      marginRight: 'auto',
      minHeight: 24,
      color: tokens.text.muted,
      '&:hover:not(:disabled), &:focus-visible': { color: tokens.text.primary, background: 'transparent' },
    },
  }),
  button: css({
    '&&': { paddingInline: 0, border: 0, color: tokens.text.primary },
  }),

  list: css({
    listStyle: 'none',
    margin: 0,
    padding: space('xs', 'lg'),
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
    // The parent row owns the highlight, including the trailing file actions.
    '&&': { borderRadius: 0, '&:hover:not(:disabled)': { background: 'transparent' } },
    paddingInline: 0,
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

  added: css({ color: tokens.diff.added, whiteSpace: 'nowrap' }),
  removed: css({ color: tokens.diff.removed, whiteSpace: 'nowrap' }),
  error: css({ color: tokens.text.error, padding: tokens.space.md }),
};

export function GlyphPendingReviews(state: GlyphPendingReviewsState) {
  return (
    <section
      class={`glyph-pending-reviews ${drawer.card} ${styles.card}`}
      aria-label="Pending reviews"
      aria-busy={state.busy}
    >
      <header class={`${drawer.header} ${styles.header}`}>
        <Button
          appearance={ButtonAppearance.GHOST}
          type="button"
          class={`glyph-review-count ${drawer.toggle} ${styles.count}`}
          aria-expanded={state.expanded}
          aria-controls={state.listId}
          onClick={state.toggle}
        >
          <ChevronUp class={drawer.chevron} data-expanded={state.expanded || undefined} size={16} aria-hidden="true" />
          <span>{state.summary}</span>
        </Button>
        <span class={styles.headerActions}>
          <Button
            size={ButtonSize.SMALL}
            appearance={ButtonAppearance.GHOST}
            type="button"
            disabled={state.disabled}
            onClick={state.undo}
          >
            {state.undoLabel}
          </Button>
          <Button
            size={ButtonSize.SMALL}
            appearance={ButtonAppearance.GHOST}
            type="button"
            disabled={state.keepDisabled}
            onClick={state.keep}
          >
            {state.keepLabel}
          </Button>
          <Button
            size={ButtonSize.SMALL}

            type="button"
            disabled={state.disabled}
            onClick={state.review}
          >
            Review
          </Button>
        </span>
      </header>
      <div
        class={drawer.reveal}
        data-expanded={state.expanded || undefined}
        aria-hidden={!state.expanded}
        inert={!state.expanded}
      >
        <div class={drawer.clip}>
          <ul class={styles.list} id={state.listId}>
            {state.files.map(file => (
              <li key={file.key}>
                <div class={styles.row}>
                  <Button
                    appearance={ButtonAppearance.GHOST}
                    class={`${styles.button} ${styles.file}`}
                    type="button"
                    title={file.path}
                    aria-label={`Review ${file.path}`}
                    disabled={state.disabled}
                    onClick={file.review}
                  >
                    <GlyphFileIcon path={file.path} />
                    <span
                      class={styles.name}
                      style={file.operation === 'DELETE' ? { textDecoration: 'line-through' } : undefined}
                    >
                      {file.name}
                    </span>
                    {file.operation === 'RENAME' && <GlyphRenameBadge />}
                    <span class={styles.added}>+{file.additions ?? 0}</span>
                    <span class={styles.removed}>−{file.deletions ?? 0}</span>
                  </Button>
                  <span class={`glyph-file-actions ${styles.actions}`}>
                    <IconButton
                      size={ButtonSize.SMALL}
                      appearance={ButtonAppearance.GHOST}

                      type="button"
                      aria-label={`${'Revert'} ${file.path}`}
                      title={'Revert file change'}
                      disabled={state.disabled}
                      onClick={file.undo}
                    >
                      {file.autoApplied ? <Undo2 size={18} aria-hidden="true" /> : <X size={20} aria-hidden="true" />}
                    </IconButton>
                    {!file.autoApplied && (
                      <IconButton
                        size={ButtonSize.SMALL}
                        appearance={ButtonAppearance.GHOST}

                        type="button"
                        aria-label={`Keep ${file.path}`}
                        title="Apply proposed changes"
                        disabled={state.disabled || !file.canKeep}
                        onClick={file.keep}
                      >
                        <Check size={18} aria-hidden="true" />
                      </IconButton>
                    )}
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
        </div>
      </div>
      {state.error && (
        <div class={styles.error} role="alert">
          {state.error}
        </div>
      )}
    </section>
  );
}
