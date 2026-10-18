import { useEffect, useId, useState } from 'preact/hooks';
import mermaid from 'mermaid';
import type { FlowDB } from 'mermaid/dist/diagrams/flowchart/flowDb.js';
import { graphlib, layout } from '@dagrejs/dagre';
import { GlyphDiagramError } from './GlyphDiagramError.ts';
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', maxTextSize: 20000, suppressErrorRendering: true });
interface LayoutNode {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
}
interface LayoutEdge {
  readonly x?: number;
  readonly y?: number;
  readonly points?: readonly { readonly x: number; readonly y: number }[];
}
interface DiagramLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly {
    readonly id: string;
    readonly label: string;
    readonly diamond: boolean;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }[];
  readonly edges: readonly { readonly path: string; readonly label: string; readonly x: number; readonly y: number }[];
}
/** Mermaid parses only. Preact creates SVG nodes so no untrusted HTML enters the native workbench. */
export function useGlyphDiagramState(source: string) {
  const id = useId().replaceAll(':', '');
  const [diagram, setDiagram] = useState<DiagramLayout>();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setError(false);
    setDiagram(undefined);
    const parse = async () => {
      if (source.length > 20000 || /%%\{|^---|<|https?:|data:|url\s*\(|image\s*:/im.test(source))
        throw new GlyphDiagramError('Unsupported diagram content.');
      const parsed = await mermaid.mermaidAPI.getDiagramFromText(source);
      if (!parsed.type.startsWith('flowchart')) throw new GlyphDiagramError('This diagram is available as source.');
      const db = parsed.db as FlowDB;
      const vertices = [...db.getVertices().values()],
        edges = db.getEdges();
      if (vertices.length > 100 || edges.length > 200 || db.getSubGraphs().length)
        throw new GlyphDiagramError('This diagram is available as source.');
      const graph = new graphlib.Graph({ multigraph: true })
        .setGraph({ rankdir: db.getDirection() ?? 'LR', marginx: 24, marginy: 24, nodesep: 30, ranksep: 60 })
        .setDefaultEdgeLabel(() => ({}));
      for (const vertex of vertices)
        graph.setNode(vertex.id, {
          width: Math.min(320, Math.max(100, (vertex.text ?? vertex.id).length * 7 + 32)),
          height: vertex.type === 'diamond' ? 90 : 50,
        });
      edges.forEach((edge, index) =>
        graph.setEdge(
          edge.start,
          edge.end,
          { label: edge.text, width: edge.text.length * 7, height: 20 },
          String(index),
        ),
      );
      layout(graph);
      const result: DiagramLayout = {
        width: graph.graph().width ?? 1,
        height: graph.graph().height ?? 1,
        nodes: vertices.map(vertex => {
          const node = graph.node(vertex.id) as LayoutNode;
          return {
            id: vertex.id,
            label: vertex.text ?? vertex.id,
            diamond: vertex.type === 'diamond',
            x: node.x ?? 0,
            y: node.y ?? 0,
            width: node.width,
            height: node.height,
          };
        }),
        edges: edges.map((edge, index) => {
          const value = graph.edge({ v: edge.start, w: edge.end, name: String(index) }) as LayoutEdge;
          return {
            label: edge.text,
            x: value.x ?? 0,
            y: value.y ?? 0,
            path: (value.points ?? []).map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' '),
          };
        }),
      };
      if (!cancelled) setDiagram(result);
    };
    void parse().catch(() => {
      if (!cancelled) setError(true);
    });
    return () => {
      cancelled = true;
    };
  }, [source]);
  return { diagram, error, source, id, expanded, toggle: () => setExpanded(value => !value) };
}
export type GlyphDiagramState = ReturnType<typeof useGlyphDiagramState>;
