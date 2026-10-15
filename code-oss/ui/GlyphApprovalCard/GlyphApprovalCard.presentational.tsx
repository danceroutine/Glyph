import type { GlyphApprovalCardState } from './useGlyphApprovalCardState.ts';
import { css, tokens, space } from '../design-system/index.ts';
import { decisionStyles as shared } from '../GlyphDecisionStyles.ts';

const styles = {
  root: css({ marginTop: tokens.space.lg }),
  command: css({
    margin: tokens.space.none,
    padding: space('lg', 'lg'),
    borderTop: tokens.border.default,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontFamily: tokens.font.family.code,
    fontSize: tokens.font.size.body,
    userSelect: 'text',
  }),
  detail: css({ padding: space('none', 'lg'), whiteSpace: 'pre-wrap' }),
};

export type GlyphApprovalCardProps = GlyphApprovalCardState;

export function GlyphApprovalCard({ request, disabled, pending, error, skip, alwaysRun, run }: GlyphApprovalCardProps) {
  return (
    <section
      class={`glyph-approval-card ${shared.card} ${styles.root}`}
      aria-label="Command approval"
      aria-busy={pending}
    >
      <header class={shared.header}>
        <span aria-hidden="true">›_</span>
        <h3>{request.title}</h3>
        <span class={shared.detail}>Pending approval</span>
      </header>
      <pre class={styles.command}>{request.command ?? request.detail}</pre>
      {request.workingDirectory && (
        <p class={`${shared.detail} ${styles.detail}`}>Working directory: {request.workingDirectory}</p>
      )}
      {request.canRemember && (
        <p class={`${shared.detail} ${styles.detail}`}>Always Run remembers this exact command in this directory.</p>
      )}
      <div class={shared.actions}>
        <button class={shared.button} type="button" disabled={disabled || pending} onClick={skip}>
          Skip
        </button>
        {request.canRemember && (
          <button
            class={`${shared.button} ${shared.secondary}`}
            type="button"
            disabled={disabled || pending}
            onClick={alwaysRun}
          >
            Always Run
          </button>
        )}
        <button class={`${shared.button} ${shared.primary}`} type="button" disabled={disabled || pending} onClick={run}>
          {pending ? 'Submitting…' : 'Run'}
        </button>
      </div>
      {disabled && <p class={shared.error}>Approve in the window that owns this chat.</p>}
      {error && (
        <div class={shared.error} role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
