import { parseMermaid } from 'beautiful-mermaid';
import { decodeXML } from 'entities';

/** Bound work before synchronous layout; a parent timeout cannot interrupt it. */
export function assertGlyphDiagramComplexity(source: string): void {
  const text = decodeXML(source);
  const statements = text.split(/[;\n]/u).filter(line => line.trim() !== '');
  if (statements.length > 201) throw new Error('Diagram has too many statements.');
  if (!/^(?:graph|flowchart|stateDiagram)\b/iu.test(text)) return;
  let graph;
  try {
    graph = parseMermaid(text);
  } catch {
    // Unsupported native syntax still gets the existing guarded Mermaid fallback.
    return;
  }
  if (graph.edges.length > 200) throw new Error('Diagram is too complex.');
}
