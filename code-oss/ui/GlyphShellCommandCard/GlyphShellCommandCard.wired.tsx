import { GlyphShellCommandCard } from './GlyphShellCommandCard.presentational.tsx';
import {
  useGlyphShellCommandCardState,
  type GlyphShellCommandCardStateOptions,
} from './useGlyphShellCommandCardState.ts';

export function WiredGlyphShellCommandCard(props: GlyphShellCommandCardStateOptions) {
  return <GlyphShellCommandCard {...useGlyphShellCommandCardState(props)} />;
}
