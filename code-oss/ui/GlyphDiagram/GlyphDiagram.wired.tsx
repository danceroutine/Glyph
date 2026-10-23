import { GlyphDiagram } from './GlyphDiagram.presentational.tsx';
import { useGlyphDiagramState } from './useGlyphDiagramState.ts';
export function WiredGlyphDiagram({ source }: { readonly source: string }) {
  return <GlyphDiagram {...useGlyphDiagramState({ source })} />;
}
