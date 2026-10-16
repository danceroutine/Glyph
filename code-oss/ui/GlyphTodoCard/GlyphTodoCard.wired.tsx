import { GlyphTodoCard } from './GlyphTodoCard.presentational.tsx';
import { useGlyphTodoCardState, type GlyphTodoCardStateOptions } from './useGlyphTodoCardState.ts';

export function WiredGlyphTodoCard(props: GlyphTodoCardStateOptions) {
  return <GlyphTodoCard {...useGlyphTodoCardState(props)} />;
}
