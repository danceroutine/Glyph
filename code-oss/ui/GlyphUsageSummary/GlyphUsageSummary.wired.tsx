import type { GlyphUsage } from '#src/desktop/protocol/events/GlyphUsage.js';
import { GlyphUsageSummary } from './GlyphUsageSummary.presentational.tsx';
import { useGlyphUsageState } from './useGlyphUsageState.ts';
export function WiredGlyphUsageSummary(props: { readonly usage: GlyphUsage | undefined; readonly turn?: boolean }) {
  return <GlyphUsageSummary {...props} {...useGlyphUsageState()} />;
}
