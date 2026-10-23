import { GlyphDiagram } from './GlyphDiagram.presentational.tsx';
import { useGlyphDiagramState } from './useGlyphDiagramState.ts';
export function WiredGlyphDiagram({
  source,
  openLink,
}: {
  readonly source: string;
  readonly openLink?: ((href: string) => void) | undefined;
}) {
  return <GlyphDiagram {...useGlyphDiagramState({ source, openLink })} />;
}
