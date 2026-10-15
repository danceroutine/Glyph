import type { GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphToolActivityStatus } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import { css, tokens, space } from './design-system/index.ts';

const styles = {
  root: css({
    color: tokens.text.muted,
    fontSize: tokens.font.size.detail,
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
  }),
  reasoning: css({ '& p': { whiteSpace: 'pre-wrap' } }),
  summary: css({
    cursor: 'pointer',
    ':focus-visible': { outline: tokens.focus.ring, outlineOffset: tokens.focus.offset },
  }),
  tools: css({
    padding: tokens.space.none,
    listStyle: 'none',
    '& li': { display: 'flex', justifyContent: 'space-between', gap: tokens.space.md, margin: space('xs', 'none') },
  }),
  toolStatus: css({
    flexShrink: 0,
    'li[aria-busy="true"] &': { color: tokens.progress.foreground },
  }),
};

export function GlyphTurnProgress({ progress }: { readonly progress: NonNullable<GlyphTranscriptEntry['progress']> }) {
  const active = [
    GlyphRunStatus.STREAMING,
    GlyphRunStatus.WAITING_FOR_QUESTION,
    GlyphRunStatus.WAITING_FOR_APPROVAL,
  ].includes(progress.status);
  return (
    <section class={`glyph-turn-progress ${styles.root}`} aria-label="Turn progress">
      {progress.reasoning && (
        <details class={`glyph-reasoning ${styles.reasoning}`}>
          <summary class={styles.summary}>Reasoning summary</summary>
          <p>{progress.reasoning}</p>
        </details>
      )}
      {progress.tools.length > 0 && (
        <ul class={`glyph-tools ${styles.tools}`} aria-label="Tool activity">
          {progress.tools.map(tool => (
            <li key={tool.id} aria-busy={active && tool.status === GlyphToolActivityStatus.STARTED}>
              <span>{tool.name}</span>
              <span class={`glyph-tool-status ${styles.toolStatus}`}>{toToolLabel(tool.status, active)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function toToolLabel(status: GlyphToolActivityStatus, active: boolean): string {
  switch (status) {
    case GlyphToolActivityStatus.STARTED:
      return active ? 'Running' : 'Interrupted';
    case GlyphToolActivityStatus.COMPLETED:
      return 'Finished';
    case GlyphToolActivityStatus.FAILED:
      return 'Failed';
    case GlyphToolActivityStatus.INTERRUPTED:
      return 'Interrupted';
  }
}
