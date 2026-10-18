import type { GlyphWorkbenchMount } from '#glyph/workbench/GlyphWorkbenchView.js';

/** The implementation is bundled from code-oss/ui during overlay generation. */
export declare const mountGlyphWorkbench: GlyphWorkbenchMount;

import type { GlyphReviewMount } from '#glyph/workbench/GlyphReviewControls.js';
export declare const mountGlyphReview: GlyphReviewMount;

import type { GlyphPlanMount } from '#glyph/workbench/GlyphPlanView.js';
export declare const mountGlyphPlan: GlyphPlanMount;

export declare const mountGlyphCommentButton: (
  container: HTMLElement,
  open: () => void,
  order?: number,
) => { dispose(): void };
