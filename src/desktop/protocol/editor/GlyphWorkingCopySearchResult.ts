import type { GlyphWorkingCopySearchMatch } from './GlyphWorkingCopySearchMatch.ts';

export interface GlyphWorkingCopySearchResult {
  readonly matches: readonly GlyphWorkingCopySearchMatch[];
  readonly truncated: boolean;
}
