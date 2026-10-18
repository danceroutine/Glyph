import { Maximize2, Minimize2 } from 'lucide-preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import type { GlyphDiagramState } from './useGlyphDiagramState.ts';
const styles = {
  root: css({
    position: 'relative',
    overflow: 'auto',
    padding: tokens.space.md,
    '& svg': { maxWidth: '100%', height: 'auto' },
    '& button': {
      position: 'absolute',
      right: tokens.space.sm,
      top: tokens.space.sm,
      color: tokens.text.muted,
      background: tokens.button.secondary.background,
      border: 0,
      borderRadius: tokens.button.radius,
      padding: tokens.space.sm,
    },
  }),
  expanded: css({
    position: 'fixed',
    inset: tokens.space.lg,
    zIndex: 1002,
    background: tokens.surface.canvas,
    border: tokens.border.default,
    '& svg': { width: '100%', height: '100%' },
  }),
};
export function GlyphDiagram({ diagram, error, source, id, expanded, toggle }: GlyphDiagramState) {
  if (error)
    return (
      <details>
        <summary>Diagram source</summary>
        <pre>{source}</pre>
      </details>
    );
  return (
    <div class={`${styles.root} ${expanded ? styles.expanded : ''}`}>
      <button type="button" aria-label={expanded ? 'Collapse diagram' : 'Expand diagram'} onClick={toggle}>
        {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
      {diagram && (
        <svg
          role="img"
          aria-label="Plan diagram"
          viewBox={`0 0 ${diagram.width} ${diagram.height}`}
          width={diagram.width}
          height={diagram.height}
        >
          <defs>
            <marker
              id={id}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L10 5 L0 10 Z" fill={tokens.text.muted} />
            </marker>
          </defs>
          {diagram.edges.map((edge, index) => (
            <g key={index}>
              <path d={edge.path} fill="none" stroke={tokens.text.muted} marker-end={`url(#${id})`} />
              <text x={edge.x} y={edge.y - 5} text-anchor="middle" fill={tokens.text.primary}>
                {edge.label}
              </text>
            </g>
          ))}
          {diagram.nodes.map(node => (
            <g key={node.id} transform={`translate(${node.x},${node.y})`}>
              {node.diamond ? (
                <polygon
                  points={`0,${-node.height / 2} ${node.width / 2},0 0,${node.height / 2} ${-node.width / 2},0`}
                  fill={tokens.input.background}
                  stroke={tokens.text.muted}
                />
              ) : (
                <rect
                  x={-node.width / 2}
                  y={-node.height / 2}
                  width={node.width}
                  height={node.height}
                  rx={tokens.badge.radius}
                  fill={tokens.input.background}
                  stroke={tokens.text.muted}
                />
              )}
              <text text-anchor="middle" dominant-baseline="middle" fill={tokens.text.primary}>
                {node.label}
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}
