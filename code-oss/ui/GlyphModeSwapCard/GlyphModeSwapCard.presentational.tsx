import { Button, ButtonVariant } from '#code-oss/ui/Button/Button.tsx';
import { GlyphModeSwapStatus } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { AgentMode } from '#src/chat/AgentMode.js';
import { AGENT_MODE_PRESENTATION } from '#code-oss/ui/AgentMode/AgentModePresentation.tsx';
import { ArrowLeftRight } from 'lucide-preact';
import type { GlyphModeSwap } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import { decisionStyles as shared } from '#code-oss/ui/GlyphDecisionStyles.ts';

const styles = {
  card: css({
    border: tokens.border.default,
    borderRadius: 12,
    padding: 12,
    overflow: 'hidden',
    margin: '16px 0',
    color: tokens.text.primary,
  }),
  heading: css({
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontSize: tokens.font.size.body,
    fontWeight: 'normal',
    margin: 0,
    '& svg': { flexShrink: 0, color: tokens.text.muted },
  }),
  description: css({
    color: tokens.text.muted,
    margin: '6px 0 0 28px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  }),
  actions: css({ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }),
  note: css({ textAlign: 'right', color: tokens.text.muted, fontSize: tokens.font.size.caption }),
  countdown: css({ height: 5, margin: '12px -12px -12px', overflow: 'hidden' }),
  remaining: css({ height: '100%', transformOrigin: 'left center' }),
};
export interface GlyphModeSwapCardProps {
  readonly swap: GlyphModeSwap;
  readonly seconds: number;
  readonly remaining: number;
  readonly disabled?: boolean;
  readonly pending?: boolean;
  readonly error?: string | undefined;
  readonly approve: () => void;
  readonly deny: () => void;
}
export function GlyphModeSwapCard({
  swap,
  seconds,
  remaining,
  disabled = false,
  pending = false,
  error,
  approve,
  deny,
}: GlyphModeSwapCardProps) {
  const target = AgentMode.resolve(swap.target).title;
  const title =
    swap.status === GlyphModeSwapStatus.APPROVED
      ? `Switched to ${target}`
      : `Switch to ${target}${swap.status === GlyphModeSwapStatus.PENDING ? '' : ` ${swap.status}`}`;
  return (
    <section
      class={`glyph-mode-swap ${styles.card}`}
      aria-label="Mode switch"
      aria-busy={swap.status === GlyphModeSwapStatus.PENDING && pending}
    >
      <h3 class={styles.heading}>
        <ArrowLeftRight size={18} aria-hidden="true" />
        <span>{title}</span>
      </h3>
      <p class={styles.description}>{swap.description}</p>
      {swap.status === GlyphModeSwapStatus.PENDING && (
        <>
          <div class={styles.actions}>
            <Button
              type="button"

              disabled={disabled || pending || seconds === 0}
              onClick={deny}
            >
              Deny
            </Button>
            <Button
              variant={ButtonVariant.PRIMARY}
              mode={swap.source}
              type="button"

              disabled={disabled || pending || seconds === 0}
              onClick={approve}
            >
              Approve
            </Button>
          </div>
          {disabled && <p class={styles.note}>Respond in the window that owns this chat.</p>}
          {error !== undefined && error !== '' && (
            <p role="alert" class={shared.error}>
              {error}
            </p>
          )}
          <div
            class={styles.countdown}
            role="progressbar"
            aria-label={`Automatic ${swap.autoApprove ? 'approval' : 'denial'} countdown`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(remaining * 100)}
            aria-valuetext={`${seconds} seconds remaining`}
          >
            <div
              class={styles.remaining}
              style={{
                transform: `scaleX(${remaining})`,
                background: AGENT_MODE_PRESENTATION[swap.source].accent,
              }}
            />
          </div>
        </>
      )}
    </section>
  );
}
