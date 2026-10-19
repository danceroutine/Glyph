import { useLayoutEffect, useRef } from 'preact/hooks';
import {
  useGlyphMessageState,
  type GlyphMessageStateOptions,
} from '#code-oss/ui/GlyphAgentMessage/useGlyphMessageState.ts';

export type GlyphTranscriptStateOptions = GlyphMessageStateOptions;
export type GlyphTranscriptState = ReturnType<typeof useGlyphTranscriptState>;

export function useGlyphTranscriptState(options: GlyphTranscriptStateOptions) {
  const state = useGlyphMessageState(options);
  const transcript = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = transcript.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [options.entries]);
  return { ...state, transcript };
}
