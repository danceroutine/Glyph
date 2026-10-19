import { createPortal } from 'preact/compat';
import { Gauge } from 'lucide-preact';
import type { GlyphUsage } from '#src/desktop/protocol/events/GlyphUsage.js';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import type { useGlyphUsageState } from './useGlyphUsageState.ts';
const styles = {
  root: css({ padding: '0 12px 10px', flexShrink: 0 }),
  button: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 0',
    border: 0,
    font: 'inherit',
    fontSize: tokens.font.size.detail,
    color: tokens.text.muted,
    background: 'transparent',
    cursor: 'pointer',
    ':hover': { color: tokens.text.primary },
    ':focus-visible': { outline: tokens.focus.ring },
  }),
  popup: css({
    position: 'fixed',
    zIndex: 2000,
    boxSizing: 'border-box',
    width: 290,
    maxWidth: 'calc(100vw - 16px)',
    padding: 16,
    border: tokens.border.default,
    borderRadius: 12,
    background: tokens.dropdown.background,
    color: tokens.text.primary,
    boxShadow: '0 8px 24px #0004',
    fontSize: tokens.font.size.detail,
    lineHeight: 1.5,
    '& dl': { display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 16px', fontVariantNumeric: 'tabular-nums' },
    '& dd': { margin: 0 },
    '& p': { color: tokens.text.muted, margin: '8px 0 0' },
  }),
};
export function GlyphUsageSummary({
  usage,
  turn,
  id,
  trigger,
  popup,
  open,
  position,
  toggle,
}: { readonly usage: GlyphUsage | undefined; readonly turn?: boolean } & ReturnType<typeof useGlyphUsageState>) {
  const label = turn ? 'Turn token usage' : 'Conversation token usage';
  return (
    <div class={`glyph-usage ${turn ? '' : styles.root}`}>
      <button
        ref={trigger}
        type="button"
        class={styles.button}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={toggle}
      >
        <Gauge size={17} aria-hidden="true" />
        {!turn && <span>Usage</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="dialog"
            aria-label={label}
            class={styles.popup}
            style={{ left: `${position.left}px`, top: `${position.top}px` }}
          >
            <strong>{turn ? 'Turn usage' : 'Conversation usage'}</strong>
            {usage ? (
              <dl>
                {(
                  [
                    ['Input', usage.inputTokens],
                    ['Cached input', usage.cachedInputTokens],
                    ['Output', usage.outputTokens],
                    ['Reasoning', usage.reasoningTokens],
                    ['Total', usage.totalTokens],
                  ] as const
                ).map(([name, value]) => (
                  <>
                    <dt>{name}</dt>
                    <dd>{value.toLocaleString()}</dd>
                  </>
                ))}
              </dl>
            ) : (
              <p>Token usage unavailable.</p>
            )}
            <p>
              {turn
                ? 'Reported usage for this turn.'
                : 'Reported usage for completed turns. Interrupted turns are excluded.'}
            </p>
            {usage && <p>Cached input is included in input; reasoning is included in output.</p>}
            {!!usage?.unreportedTurns && (
              <p role="status">
                Usage missing or incomplete for {usage.unreportedTurns} completed{' '}
                {usage.unreportedTurns === 1 ? 'turn' : 'turns'}.
              </p>
            )}
          </div>,
          document.querySelector('.monaco-workbench') ??
            trigger.current?.closest('.glyph-story-stage') ??
            document.body,
        )}
    </div>
  );
}
