import { GlyphApprovalCard } from './GlyphApprovalCard.presentational.tsx';
import { useGlyphApprovalCardState, type GlyphApprovalCardStateOptions } from './useGlyphApprovalCardState.ts';

export type WiredGlyphApprovalCardProps = GlyphApprovalCardStateOptions;

export function WiredGlyphApprovalCard(props: WiredGlyphApprovalCardProps) {
  const state = useGlyphApprovalCardState(props);
  return <GlyphApprovalCard {...state} />;
}
