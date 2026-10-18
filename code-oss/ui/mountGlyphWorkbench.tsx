import { GlyphCommentButton } from './GlyphAnnotations/GlyphCommentButton.presentational.tsx';
import type { GlyphPlanMount } from '#src/desktop/workbench/GlyphPlanView.js';
import { WiredGlyphPlan } from './GlyphPlan/GlyphPlan.wired.tsx';
import type { GlyphReviewMount } from '#src/desktop/workbench/GlyphReviewControls.js';
import { WiredGlyphReviewControls } from './GlyphReviewControls/GlyphReviewControls.wired.tsx';
import { render } from 'preact';
import type { GlyphWorkbenchMount } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { WiredGlyphWorkbench } from './GlyphWorkbench/GlyphWorkbench.wired.tsx';

/** Unmounting through Preact releases component effects when Code OSS disposes the pane. */
export const mountGlyphWorkbench: GlyphWorkbenchMount = (container, state, actions) => {
  let disposed = false;
  const update = (next: typeof state) => {
    if (!disposed) render(<WiredGlyphWorkbench state={next} actions={actions} />, container);
  };
  update(state);
  return {
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      render(null, container);
    },
  };
};

export const mountGlyphReview: GlyphReviewMount = (container, controls) => {
  const update = (next: typeof controls) => render(<WiredGlyphReviewControls {...next} />, container);
  update(controls);
  return { update, dispose: () => render(null, container) };
};

export const mountGlyphPlan: GlyphPlanMount = (container, state, actions) => {
  const update = (next: typeof state) => render(<WiredGlyphPlan state={next} actions={actions} />, container);
  update(state);
  return { update, dispose: () => render(null, container) };
};

export const mountGlyphCommentButton = (container: HTMLElement, open: () => void, order?: number) => {
  render(<GlyphCommentButton open={open} {...(order ? { order } : {})} />, container);
  return { dispose: () => render(null, container) };
};
