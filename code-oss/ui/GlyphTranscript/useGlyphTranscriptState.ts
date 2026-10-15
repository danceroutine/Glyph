import { useLayoutEffect, useRef } from 'preact/hooks';
import { GlyphTranscriptRole, type GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';

export interface GlyphTranscriptStateOptions {
  readonly entries: readonly GlyphTranscriptEntry[];
}

export type GlyphTranscriptState = ReturnType<typeof useGlyphTranscriptState>;

export function useGlyphTranscriptState({ entries }: GlyphTranscriptStateOptions) {
  const transcript = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = transcript.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries]);
  return { transcript, entries: entries.map(entry => ({ ...entry, label: roleLabel(entry.role) })) };
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
