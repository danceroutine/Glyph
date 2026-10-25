import type { GlyphWorkbenchMount } from '#glyph/workbench/GlyphWorkbenchView.js';

/** The implementation is bundled from code-oss/ui during overlay generation. */
export declare const mountGlyphWorkbench: GlyphWorkbenchMount;

import type { GlyphReviewMount } from '#glyph/workbench/GlyphReviewControls.js';
export declare const mountGlyphReview: GlyphReviewMount;

import type { GlyphPlanMount } from '#glyph/workbench/GlyphPlanView.js';
export declare const mountGlyphPlan: GlyphPlanMount;
export declare const mountGlyphAgentInstructions: (
  container: HTMLElement,
  sources: readonly import('#glyph/protocol/events/GlyphInstructionSource.js').GlyphInstructionSource[],
  query: string,
  openSource: (source: import('#glyph/protocol/events/GlyphInstructionSource.js').GlyphInstructionSource) => void,
) => {
  update(
    sources: readonly import('#glyph/protocol/events/GlyphInstructionSource.js').GlyphInstructionSource[],
    query: string,
  ): void;
  dispose(): void;
};

export declare const mountGlyphCommentButton: (
  container: HTMLElement,
  open: () => void,
  order?: number,
  shortcut?: string,
) => { dispose(): void };

export declare const mountGlyphEditorAnnotationMarker: (
  container: HTMLElement,
  order: number,
  comment: string,
  open: () => void,
) => { dispose(): void };

export declare const mountGlyphContextButton: (
  container: HTMLElement,
  label: string,
  action: () => void,
  primary?: boolean,
  shortcut?: string,
) => { dispose(): void };

import type { GlyphAgentReviewMount } from '#glyph/workbench/GlyphAgentReview.js';
export declare const mountGlyphAgentReview: GlyphAgentReviewMount;
export declare function mountGlyphAgentReviewComment(
  container: HTMLElement,
  finding: import('#glyph/workbench/GlyphAgentReviewFinding.js').GlyphAgentReviewFinding,
  fix: () => void,
  dismiss: () => void,
): { dispose(): void };
