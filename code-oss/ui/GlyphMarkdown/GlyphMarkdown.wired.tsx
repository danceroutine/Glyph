import { GlyphMarkdown } from './GlyphMarkdown.presentational.tsx';
import { useGlyphMarkdownState } from './useGlyphMarkdownState.ts';
import { WiredGlyphDiagram } from '#code-oss/ui/GlyphDiagram/GlyphDiagram.wired.tsx';
export function WiredGlyphMarkdown({
  text,
  openLink,
}: {
  readonly text: string;
  readonly openLink: (href: string) => void;
}) {
  const items = useGlyphMarkdownState(text);
  return <GlyphMarkdown items={items} openLink={openLink} diagram={source => <WiredGlyphDiagram source={source} />} />;
}
