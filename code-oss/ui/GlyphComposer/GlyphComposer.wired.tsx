import type { ComponentChildren } from 'preact';
import { GlyphComposer } from './GlyphComposer.presentational.tsx';
import { useGlyphComposerState, type GlyphComposerStateOptions } from './useGlyphComposerState.ts';

export interface WiredGlyphComposerProps extends GlyphComposerStateOptions {
  readonly modelControl?: ComponentChildren;
}

export function WiredGlyphComposer({ modelControl, ...props }: WiredGlyphComposerProps) {
  const state = useGlyphComposerState(props);
  return <GlyphComposer {...state} modelControl={modelControl} />;
}
