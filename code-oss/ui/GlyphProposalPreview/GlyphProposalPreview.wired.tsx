import { GlyphProposalPreview } from './GlyphProposalPreview.presentational.tsx';
import {
  useGlyphPendingReviewsState,
  type GlyphPendingReviewsStateOptions,
} from '#code-oss/ui/GlyphPendingReviews/useGlyphPendingReviewsState.ts';
export function WiredGlyphProposalPreviews(props: GlyphPendingReviewsStateOptions) {
  const state = useGlyphPendingReviewsState(props);
  return (
    <>
      {state.files.map(file => (
        <GlyphProposalPreview
          key={file.key}
          file={file}
          name={file.name}
          open={file.review}
          disabled={state.disabled}
        />
      ))}
      {state.error && <div role="alert">{state.error}</div>}
    </>
  );
}
