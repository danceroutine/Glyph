import { GlyphGoalRow } from './GlyphGoalRow.presentational.tsx';
import { useGlyphGoalRowState, type GlyphGoalRowStateOptions } from './useGlyphGoalRowState.ts';

export function WiredGlyphGoalRow(props: GlyphGoalRowStateOptions) {
  return <GlyphGoalRow {...useGlyphGoalRowState(props)} />;
}
