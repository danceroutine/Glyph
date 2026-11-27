import { GlyphSkillFileComparison } from '#code-oss/ui/GlyphSkills/GlyphSkillFileComparison.tsx';
import { Button, ButtonAppearance, ButtonVariant } from '#code-oss/ui/Button/Button.tsx';
import { Target, Terminal, Sparkles } from 'lucide-preact';
import type { GlyphApprovalCardState } from './useGlyphApprovalCardState.ts';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';
import { decisionStyles as shared } from '#code-oss/ui/GlyphDecisionStyles.ts';

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
  objective: css({
    margin: tokens.space.none,
    padding: space('lg', 'lg'),
    borderTop: tokens.border.default,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    userSelect: 'text',
  }),
  detail: css({ padding: space('none', 'lg'), whiteSpace: 'pre-wrap' }),
};

export type GlyphApprovalCardProps = GlyphApprovalCardState;

export function GlyphApprovalCard({
  request,
  disabled,
  pending,
  error,
  skip,
  alwaysRun,
  run,
  decide,
}: GlyphApprovalCardProps) {
  const goal = request.goal;
  const skillChange = request.skillChange;
  const Icon = goal ? Target : skillChange ? Sparkles : Terminal;
  return (
    <section
      class={`glyph-approval-card ${shared.card} ${styles.root}`}
      aria-label={goal ? 'Goal approval' : skillChange ? 'Skill change approval' : 'Command approval'}
      aria-busy={pending}
    >
      <header class={shared.header}>
        <Icon size={16} aria-hidden="true" />
        <h3>{escapeDisplayControls(request.title, true)}</h3>
        <span class={shared.detail}>Pending approval</span>
      </header>
      {goal ? (
        <p class={styles.objective}>{goal.objective}</p>
      ) : skillChange ? (
        <div class={styles.command}>
          <p>
            {escapeDisplayControls(skillChange.source, true)} · {skillChange.revision.slice(0, 12)}
          </p>
          {skillChange.destination && (
            <p>
              Destination ({skillChange.destination.scope}) ·{' '}
              {escapeDisplayControls(skillChange.destination.label, true)}
              <br />
              <code>{escapeDisplayControls(skillChange.destination.path, true)}</code>
            </p>
          )}
          <GlyphSkillFileComparison files={skillChange.files} />
        </div>
      ) : (
        <pre class={styles.command}>{escapeDisplayControls(request.command ?? request.detail)}</pre>
      )}
      {goal && (
        <p class={`${shared.detail} ${styles.detail}`}>
          Glyph keeps working toward this goal across turns until it is complete, paused, or cleared.
        </p>
      )}
      {request.workingDirectory !== undefined && request.workingDirectory !== '' && (
        <p class={`${shared.detail} ${styles.detail}`}>Working directory: {request.workingDirectory}</p>
      )}
      {request.choices === undefined && request.canRemember === true && (
        <p class={`${shared.detail} ${styles.detail}`}>Always Run remembers this exact command in this directory.</p>
      )}
      <div class={shared.actions}>
        {request.choices ? (
          request.choices.map(choice => (
            <div key={choice.id}>
              <Button
                type="button"
                disabled={disabled || pending}
                onClick={() => {
                  decide(choice.id);
                }}
              >
                {choice.label}
              </Button>
              <p class={shared.detail}>{choice.description}</p>
            </div>
          ))
        ) : (
          <>
            <Button appearance={ButtonAppearance.GHOST} type="button" disabled={disabled || pending} onClick={skip}>
              {goal ? 'Decline' : skillChange ? 'Keep unchanged' : 'Skip'}
            </Button>
            {request.choices === undefined && request.canRemember === true && (
              <Button type="button" disabled={disabled || pending} onClick={alwaysRun}>
                Always Run
              </Button>
            )}
            <Button variant={ButtonVariant.PRIMARY} type="button" disabled={disabled || pending} onClick={run}>
              {pending ? 'Submitting…' : goal ? 'Start goal' : skillChange ? 'Apply change' : 'Run'}
            </Button>
          </>
        )}
      </div>
      {disabled && <p class={shared.error}>Approve in the window that owns this chat.</p>}
      {error !== undefined && error !== '' && (
        <div class={shared.error} role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
import { escapeDisplayControls } from '#src/shared/presentation/escapeDisplayControls.js';
