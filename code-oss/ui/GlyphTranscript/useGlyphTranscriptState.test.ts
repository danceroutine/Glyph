import { renderHook } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import { GlyphTranscriptRole } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import { useGlyphTranscriptState } from '#code-oss/ui/GlyphTranscript/useGlyphTranscriptState.ts';

describe(useGlyphTranscriptState, () => {
  it('prepares labeled entries before the transcript is shown', () => {
    const { result } = renderHook(useGlyphTranscriptState, {
      initialProps: {
        entries: [
          { id: 'u', role: GlyphTranscriptRole.USER, text: 'Hello' },
          { id: 'a', role: GlyphTranscriptRole.ASSISTANT, text: 'Hi' },
          { id: 'd', role: GlyphTranscriptRole.DIAGNOSTIC, text: 'Reconnected' },
        ],
      },
    });

    expect(result.current.entries.map(entry => [entry.id, entry.label])).toEqual([
      ['u', 'You'],
      ['a', 'Glyph'],
      ['d', 'Status'],
    ]);
    expect(result.current.transcript.current).toBeNull();
  });
});
