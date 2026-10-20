import { ButtonSize, ButtonAppearance, IconButton } from '#code-oss/ui/Button/Button.tsx';
import { composerDrawerStyles as drawer } from '#code-oss/ui/GlyphComposer/GlyphComposerDrawer.styles.ts';
import { CirclePause, CirclePlay, Target, X } from 'lucide-preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import type { GlyphGoalRowState } from './useGlyphGoalRowState.ts';

const styles = {
  card: css({ overflow: 'hidden' }),
  icon: css({ flexShrink: 0, color: tokens.text.muted, '&[data-active]': { color: tokens.text.primary } }),
  objective: css({
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: tokens.text.primary,
    userSelect: 'text',
  }),
  meta: css({ display: 'inline-flex', gap: tokens.space.md, color: tokens.text.muted, whiteSpace: 'nowrap' }),
  actions: css({ display: 'inline-flex', gap: tokens.space.xxs }),
  error: css({ color: tokens.text.error, padding: tokens.space.md }),
};

export function GlyphGoalRow(state: GlyphGoalRowState) {
  return (
    <section class={`glyph-goal-row ${drawer.card} ${styles.card}`} aria-label="Goal" aria-busy={state.pending}>
      <div class={drawer.header}>
        <Target class={styles.icon} data-active={state.status === 'active' || undefined} size={16} aria-hidden="true" />
        <span class={styles.objective} title={state.objective}>
          {state.objective}
        </span>
        <span class={styles.meta}>
          <span aria-live="polite">{state.statusLabel}</span>
          <span aria-label={`Worked for ${state.elapsed}`}>{state.elapsed}</span>
        </span>
        <span class={styles.actions}>
          {state.canToggle && (
            <IconButton
              size={ButtonSize.SMALL}
              appearance={ButtonAppearance.GHOST}
              type="button"
              aria-label={state.toggleLabel}
              title={state.toggleLabel}
              disabled={state.disabled}
              onClick={state.toggle}
            >
              {state.status === 'active' ? (
                <CirclePause size={16} aria-hidden="true" />
              ) : (
                <CirclePlay size={16} aria-hidden="true" />
              )}
            </IconButton>
          )}
          <IconButton
            size={ButtonSize.SMALL}
            appearance={ButtonAppearance.GHOST}
            type="button"
            aria-label="Clear goal"
            title="Clear goal"
            disabled={state.disabled}
            onClick={state.clear}
          >
            <X size={16} aria-hidden="true" />
          </IconButton>
        </span>
      </div>
      {state.error && (
        <div class={styles.error} role="alert">
          {state.error}
        </div>
      )}
    </section>
  );
}
