import type { GlyphToolActivity } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import type { GlyphShellCommand } from '#src/desktop/protocol/events/GlyphShellCommand.js';
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
  return {
    transcript,
    entries: entries.map(entry => ({
      ...entry,
      label: roleLabel(entry.role),
      ...(entry.progress
        ? { progress: { ...entry.progress, tools: entry.progress.tools.filter(tool => !tool.shell) } }
        : {}),
      shellActivities: (entry.progress?.tools ?? []).filter(
        (tool): tool is GlyphToolActivity & { readonly shell: GlyphShellCommand } => tool.shell !== undefined,
      ),
    })),
  };
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
