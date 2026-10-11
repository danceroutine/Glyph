import type { GlyphProposalFileSummary } from './GlyphProposalFileSummary.ts';

export interface GlyphProposalSummary {
  readonly id: string;
  readonly chatId?: string;
  readonly createdAt: string;
  readonly files: readonly GlyphProposalFileSummary[];
}
