export enum GlyphProposalApplicability {
  READY = 'ready',
  APPLYING = 'applying',
  STALE = 'stale',
  FAILED_RETRYABLE = 'failed_retryable',
}

export interface GlyphProposalFileSummary {
  readonly id: string;
  readonly path: string;
  readonly proposedUri: string;
  readonly pendingItemIds: readonly string[];
  readonly additions?: number;
  readonly deletions?: number;
  readonly preview?: readonly { readonly added: boolean; readonly text: string }[];
  readonly textOnly?: boolean;
  readonly applicability: GlyphProposalApplicability;
}
