import { render } from 'preact';
import type { GlyphWorkbenchMount } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { GlyphWorkbench } from './GlyphWorkbench.tsx';

/** Unmounting through Preact releases component effects when Code OSS disposes the pane. */
export const mountGlyphWorkbench: GlyphWorkbenchMount = (container, state, actions) => {
  let disposed = false;
  const update = (next: typeof state) => {
    if (!disposed) render(<GlyphWorkbench state={next} actions={actions} />, container);
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
