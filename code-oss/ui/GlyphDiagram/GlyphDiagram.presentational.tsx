import { Maximize2, Minimize2 } from 'lucide-preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import type { GlyphDiagramState } from './useGlyphDiagramState.ts';
const styles = {
  root: css({
    position: 'relative',
    overflow: 'auto',
    padding: '32px 8px 8px',
    minHeight: 80,
    '& > img': { display: 'block', maxWidth: '100%', height: 'auto', margin: '0 auto' },
  }),
  button: css({
    position: 'absolute',
    right: 4,
    top: 4,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    minWidth: 28,
    padding: 0,
    boxSizing: 'border-box',
    lineHeight: 1,
    color: tokens.text.muted,
    background: tokens.button.secondary.background,
    border: 0,
    borderRadius: tokens.button.radius,
    cursor: 'pointer',
    '& > svg': { width: 16, height: 16, flexShrink: 0 },
    ':focus-visible': { outline: tokens.focus.ring },
  }),
  expanded: css({
    position: 'fixed',
    inset: tokens.space.lg,
    zIndex: 1002,
    background: tokens.surface.canvas,
    border: tokens.border.default,
    '& > img': { width: '100%', height: '100%', objectFit: 'contain' },
  }),
};
export function GlyphDiagram({ root, diagram, error, source, expanded, toggle }: GlyphDiagramState) {
  if (error)
    return (
      <details>
        <summary>Diagram source</summary>
        <pre>{source}</pre>
      </details>
    );
  return (
    <div ref={root} class={`${styles.root} ${expanded ? styles.expanded : ''}`}>
      <button
        class={styles.button}
        type="button"
        aria-label={expanded ? 'Collapse diagram' : 'Expand diagram'}
        onClick={toggle}
      >
        {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
      {diagram ? <img src={diagram} alt="Plan diagram" /> : <span role="status">Rendering diagram…</span>}
    </div>
  );
}
