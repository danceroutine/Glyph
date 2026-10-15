import { GlyphQuestionCard } from './GlyphQuestionCard.presentational.tsx';
import { useGlyphQuestionCardState, type GlyphQuestionCardStateOptions } from './useGlyphQuestionCardState.ts';

export type WiredGlyphQuestionCardProps = GlyphQuestionCardStateOptions;

export function WiredGlyphQuestionCard(props: WiredGlyphQuestionCardProps) {
  const state = useGlyphQuestionCardState(props);
  return <GlyphQuestionCard {...state} />;
}
