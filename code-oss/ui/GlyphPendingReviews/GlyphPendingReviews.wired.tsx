import { GlyphPendingReviews } from './GlyphPendingReviews.presentational.tsx';
import { useGlyphPendingReviewsState, type GlyphPendingReviewsStateOptions } from './useGlyphPendingReviewsState.ts';
export function WiredGlyphPendingReviews(props: GlyphPendingReviewsStateOptions) {
  return <GlyphPendingReviews {...useGlyphPendingReviewsState(props)} />;
}
