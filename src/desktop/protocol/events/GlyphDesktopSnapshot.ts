import type { GlyphBackgroundShell } from './GlyphBackgroundShell.ts';
import type { GlyphAccountSummary } from './GlyphAccountSummary.ts';
import type { GlyphModelSummary } from './GlyphModelSummary.ts';
import type { GlyphChatSummary } from './GlyphChatSummary.ts';
import type { GlyphProposalSummary } from './GlyphProposalSummary.ts';
import type { GlyphRunProjection } from './GlyphRunProjection.ts';
import type { GlyphUsage } from './GlyphUsage.ts';

/** Full recoverable projection used when replay is unavailable or unsafe. */
export interface GlyphDesktopSnapshot {
  readonly accounts: readonly GlyphAccountSummary[];
  readonly models: readonly GlyphModelSummary[];
  readonly chats: readonly GlyphChatSummary[];
  readonly runs: readonly GlyphRunProjection[];
  readonly shells?: readonly GlyphBackgroundShell[];
  readonly proposals: readonly GlyphProposalSummary[];
  readonly ownerWindowId: string;
  readonly readOnly: boolean;
  readonly sequence: number;
  readonly usageByChat?: Readonly<Record<string, GlyphUsage>>;
  readonly selectedAccount?: { readonly provider: string; readonly id: string };
  readonly selectedModel?: string;
}
