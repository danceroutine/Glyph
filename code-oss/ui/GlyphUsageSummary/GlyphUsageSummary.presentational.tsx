import type { GlyphUsage } from '#src/desktop/protocol/events/GlyphUsage.js';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';

const styles = {
  root: css({
    color: tokens.text.muted,
    fontSize: tokens.font.size.detail,
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    padding: space('md', 'lg'),
    borderTop: tokens.border.default,
    maxHeight: '35%',
    overflowY: 'auto',
    '& dl': {
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      gap: space('xs', 'lg'),
      fontVariantNumeric: 'tabular-nums',
    },
    '& dd': { margin: tokens.space.none, textAlign: 'right' },
  }),
  summary: css({
    cursor: 'pointer',
    ':focus-visible': { outline: tokens.focus.ring, outlineOffset: tokens.focus.offset },
  }),
};

export function GlyphUsageSummary({ usage }: { readonly usage: GlyphUsage | undefined }) {
  return (
    <details class={`glyph-usage ${styles.root}`} aria-label="Conversation token usage">
      <summary class={styles.summary}>
        {usage
          ? `${usage.totalTokens.toLocaleString()} reported tokens${usage.unreportedTurns ? ' · incomplete' : ''}`
          : 'Token usage unavailable'}
      </summary>
      {usage && (
        <dl>
          <dt>Input</dt>
          <dd>{usage.inputTokens.toLocaleString()}</dd>
          <dt>Cached input</dt>
          <dd>{usage.cachedInputTokens.toLocaleString()}</dd>
          <dt>Output</dt>
          <dd>{usage.outputTokens.toLocaleString()}</dd>
          <dt>Reasoning</dt>
          <dd>{usage.reasoningTokens.toLocaleString()}</dd>
          <dt>Total</dt>
          <dd>{usage.totalTokens.toLocaleString()}</dd>
        </dl>
      )}
      <p>Reported usage for completed turns. Interrupted turns are excluded.</p>
      <p>Cached input is included in input; reasoning is included in output.</p>
      {!!usage?.unreportedTurns && (
        <p role="status">
          Usage missing or incomplete for {usage.unreportedTurns} completed{' '}
          {usage.unreportedTurns === 1 ? 'turn' : 'turns'}.
        </p>
      )}
    </details>
  );
}
