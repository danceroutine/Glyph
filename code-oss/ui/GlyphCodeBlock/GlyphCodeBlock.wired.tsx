import { GlyphCodeBlock } from './GlyphCodeBlock.presentational.tsx';
import { useGlyphCodeBlockState } from './useGlyphCodeBlockState.ts';
export function WiredGlyphCodeBlock({
  source,
  language,
  copyText,
}: {
  readonly copyText?: ((text: string) => Promise<void>) | undefined;
  readonly source: string;
  readonly language?: string | undefined;
}) {
  return <GlyphCodeBlock {...useGlyphCodeBlockState(source, language, copyText)} />;
}
