import { useLayoutEffect, useRef } from 'preact/hooks';
import { GlyphTranscriptRole, type GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';

interface GlyphTranscriptProps {
  readonly entries: readonly GlyphTranscriptEntry[];
}

/** Stable turn keys preserve DOM identity instead of recreating the transcript on each delta. */
export function GlyphTranscript({ entries }: GlyphTranscriptProps) {
  const transcript = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = transcript.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries]);
  return (
    <div class="glyph-transcript" ref={transcript} role="log" aria-label="Glyph conversation">
      {entries.map(entry => (
        <div class={`glyph-entry ${entry.role}`} key={entry.id}>
          <strong>{roleLabel(entry.role)}</strong>
          <div>{entry.text}</div>
        </div>
      ))}
    </div>
  );
}

function roleLabel(role: GlyphTranscriptRole): string {
  switch (role) {
    case GlyphTranscriptRole.USER:
      return 'You';
    case GlyphTranscriptRole.ASSISTANT:
      return 'Glyph';
    case GlyphTranscriptRole.DIAGNOSTIC:
      return 'Status';
  }
}
