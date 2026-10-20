import { IconButton, ButtonAppearance } from '#code-oss/ui/Button/Button.tsx';
import { Maximize2, Minimize2 } from 'lucide-preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import type { GlyphDiagramState } from './useGlyphDiagramState.ts';
const styles = {
  position: css({ position: 'absolute', right: 4, top: 4 }),
  root: css({
    position: 'relative',
    overflow: 'auto',
    padding: '32px 8px 8px',
    minHeight: 80,
  }),

  expanded: css({
    position: 'fixed',
    inset: tokens.space.lg,
    zIndex: 1002,
    background: tokens.surface.canvas,
    border: tokens.border.default,
  }),
};
export function GlyphDiagram({
  root,
  canvas,
  rendered,
  interactive,
  error,
  source,
  expanded,
  toggle,
}: GlyphDiagramState) {
  if (error)
    return (
      <details>
        <summary>Diagram source</summary>
        <pre>{source}</pre>
      </details>
    );
  return (
    <div ref={root} class={`${styles.root} ${expanded ? styles.expanded : ''}`}>
      <IconButton
        appearance={ButtonAppearance.FILLED}
        class={styles.position}
        type="button"
        aria-label={expanded ? 'Collapse diagram' : 'Expand diagram'}
        onClick={toggle}
      >
        {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </IconButton>
      {rendered ? (
        <div
          ref={canvas}
          role={interactive ? 'figure' : 'img'}
          aria-label="Plan diagram"
          data-expanded={expanded ? '' : undefined}
        />
      ) : (
        <span role="status">Rendering diagram…</span>
      )}
    </div>
  );
}
