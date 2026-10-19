import { GlyphAgentReviewComment } from './GlyphAgentReview/GlyphAgentReviewComment.tsx';
import { GlyphFileIcons } from './GlyphFileIcon/GlyphFileIcon.tsx';
import { GlyphAgentReview } from './GlyphAgentReview/GlyphAgentReview.presentational.tsx';
import type { GlyphAgentReviewMount } from '#src/desktop/workbench/GlyphAgentReview.js';
import { Button, ButtonAppearance, ButtonVariant } from './Button/Button.tsx';
import { GlyphEditorAnnotationMarker } from './GlyphAnnotations/GlyphEditorAnnotationMarker.tsx';
import { configureGlyphDiagramRenderer } from './GlyphDiagram/GlyphDiagramRenderer.ts';
import { GlyphCommentButton } from './GlyphAnnotations/GlyphCommentButton.presentational.tsx';
import type { GlyphPlanMount } from '#src/desktop/workbench/GlyphPlanView.js';
import { WiredGlyphPlan } from './GlyphPlan/GlyphPlan.wired.tsx';
import type { GlyphReviewMount } from '#src/desktop/workbench/GlyphReviewControls.js';
import { WiredGlyphReviewControls } from './GlyphReviewControls/GlyphReviewControls.wired.tsx';
import { render } from 'preact';
import type { GlyphWorkbenchMount } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { WiredGlyphWorkbench } from './GlyphWorkbench/GlyphWorkbench.wired.tsx';

if (import.meta.url) configureGlyphDiagramRenderer(new URL('./glyph-diagram.html', import.meta.url).href);

/** Unmounting through Preact releases component effects when Code OSS disposes the pane. */
export const mountGlyphWorkbench: GlyphWorkbenchMount = (container, state, actions) => {
  let disposed = false;
  const update = (next: typeof state) => {
    if (!disposed)
      render(
        <GlyphFileIcons.Provider value={actions.fileIconClasses}>
          <WiredGlyphWorkbench state={next} actions={actions} />
        </GlyphFileIcons.Provider>,
        container,
      );
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

export const mountGlyphCommentButton = (
  container: HTMLElement,
  open: () => void,
  order?: number,
  shortcut?: string,
) => {
  render(
    <GlyphCommentButton open={open} {...(order ? { order } : {})} {...(shortcut ? { shortcut } : {})} />,
    container,
  );
  return { dispose: () => render(null, container) };
};

export const mountGlyphEditorAnnotationMarker = (
  container: HTMLElement,
  order: number,
  comment: string,
  open: () => void,
) => {
  render(<GlyphEditorAnnotationMarker order={order} comment={comment} open={open} />, container);
  return { dispose: () => render(null, container) };
};

export const mountGlyphContextButton = (
  container: HTMLElement,
  label: string,
  action: () => void,
  primary = false,
  shortcut?: string,
) => {
  render(
    <Button
      variant={primary ? ButtonVariant.PRIMARY : ButtonVariant.SECONDARY}
      appearance={primary ? ButtonAppearance.FILLED : ButtonAppearance.OUTLINE}
      onMouseDown={event => event.preventDefault()}
      onClick={action}
      shortcut={shortcut}
    >
      {label}
    </Button>,
    container,
  );
  return { dispose: () => render(null, container) };
};

export const mountGlyphAgentReview: GlyphAgentReviewMount = (container, controls) => {
  const update = (next: typeof controls) => render(<GlyphAgentReview {...next} />, container);
  update(controls);
  return { update, dispose: () => render(null, container) };
};

export const mountGlyphAgentReviewComment = (
  container: HTMLElement,
  finding: import('#src/desktop/workbench/GlyphAgentReviewFinding.js').GlyphAgentReviewFinding,
  fix: () => void,
  dismiss: () => void,
) => {
  render(<GlyphAgentReviewComment finding={finding} fix={fix} dismiss={dismiss} />, container);
  return { dispose: () => render(null, container) };
};
