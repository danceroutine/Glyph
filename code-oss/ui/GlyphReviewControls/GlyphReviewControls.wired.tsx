import type { GlyphReviewControls as Controls } from '#src/desktop/workbench/GlyphReviewControls.js';
import { GlyphReviewControls } from './GlyphReviewControls.presentational.tsx';
import { useGlyphReviewControlsState } from './useGlyphReviewControlsState.ts';
export function WiredGlyphReviewControls(props: Controls) {
  return <GlyphReviewControls {...useGlyphReviewControlsState(props)} />;
}
