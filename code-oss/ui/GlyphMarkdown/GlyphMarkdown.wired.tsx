import { WiredGlyphCodeBlock } from '#code-oss/ui/GlyphCodeBlock/GlyphCodeBlock.wired.tsx';
import { GlyphMarkdown } from './GlyphMarkdown.presentational.tsx';
import { useGlyphMarkdownState } from './useGlyphMarkdownState.ts';
import { WiredGlyphDiagram } from '#code-oss/ui/GlyphDiagram/GlyphDiagram.wired.tsx';
export function WiredGlyphMarkdown({
  text,
  openLink,
  copyText,
}: {
  readonly copyText?: ((text: string) => Promise<void>) | undefined;
  readonly text: string;
  readonly openLink: (href: string) => void;
}) {
  const items = useGlyphMarkdownState(text);
  return (
    <GlyphMarkdown
      items={items}
      code={(source, language) => <WiredGlyphCodeBlock copyText={copyText} source={source} language={language} />}
      openLink={openLink}
      diagram={source => <WiredGlyphDiagram source={source} openLink={openLink} />}
    />
  );
}
