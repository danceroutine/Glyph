import type { GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphToolActivityStatus } from '#src/desktop/protocol/events/GlyphToolActivity.js';

export function GlyphTurnProgress({ progress }: { readonly progress: NonNullable<GlyphTranscriptEntry['progress']> }) {
  const active = [
    GlyphRunStatus.STREAMING,
    GlyphRunStatus.WAITING_FOR_QUESTION,
    GlyphRunStatus.WAITING_FOR_APPROVAL,
  ].includes(progress.status);
  return (
    <section class="glyph-turn-progress" aria-label="Turn progress">
      {progress.reasoning && (
        <details class="glyph-reasoning">
          <summary>Reasoning summary</summary>
          <p>{progress.reasoning}</p>
        </details>
      )}
      {progress.tools.length > 0 && (
        <ul class="glyph-tools" aria-label="Tool activity">
          {progress.tools.map(tool => (
            <li key={tool.id} aria-busy={active && tool.status === GlyphToolActivityStatus.STARTED}>
              <span>{tool.name}</span>
              <span class="glyph-tool-status">{toToolLabel(tool.status, active)}</span>
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
