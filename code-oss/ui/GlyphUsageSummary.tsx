import type { GlyphUsage } from '#src/desktop/protocol/events/GlyphUsage.js';

export function GlyphUsageSummary({ usage }: { readonly usage: GlyphUsage | undefined }) {
  return (
    <details class="glyph-usage" aria-label="Conversation token usage">
      <summary>
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
