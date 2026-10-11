import type { GlyphTextPosition } from './GlyphTextPosition.ts';

export interface GlyphTextRange {
  readonly start: GlyphTextPosition;
  readonly end: GlyphTextPosition;
}
