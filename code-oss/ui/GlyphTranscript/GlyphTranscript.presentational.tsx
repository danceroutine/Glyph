import type { ComponentChildren } from 'preact';
import type { GlyphTranscriptState } from './useGlyphTranscriptState.ts';
import { GlyphTurnProgress } from '#code-oss/ui/GlyphTurnProgress/GlyphTurnProgress.presentational.tsx';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const styles = {
  root: css({ flex: 1, minHeight: 0, overflowY: 'auto', padding: tokens.space.lg }),
  entry: css({ marginBottom: tokens.space.lg, whiteSpace: 'pre-wrap', userSelect: 'text' }),
};

export interface GlyphTranscriptProps {
  readonly transcript: GlyphTranscriptState['transcript'];
  readonly entries: readonly (GlyphTranscriptState['entries'][number] & {
    readonly approval?: ComponentChildren;
    readonly shells?: ComponentChildren;
  })[];
}

/** Stable turn keys preserve DOM identity across streaming updates. */
export function GlyphTranscript({ entries, transcript }: GlyphTranscriptProps) {
  return (
    <div class={`glyph-transcript ${styles.root}`} ref={transcript} role="log" aria-label="Glyph conversation">
      {entries.map(entry => (
        <div class={`glyph-entry ${entry.role} ${styles.entry}`} key={entry.id}>
          <strong>{entry.label}</strong>
          {entry.progress && <GlyphTurnProgress progress={entry.progress} />}
          <div>{entry.text}</div>
          {entry.approval}
          {entry.shells}
        </div>
      ))}
    </div>
  );
}
