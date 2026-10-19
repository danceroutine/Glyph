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
  readonly textOnly?: boolean;
  readonly operation?: 'CREATE' | 'UPDATE' | 'DELETE' | 'RENAME';
  readonly automaticItemId?: string;
  readonly autoApplied?: boolean;
  readonly sourcePath?: string;
  readonly beforePreview?: string;
  readonly afterPreview?: string;
  readonly applicability: GlyphProposalApplicability;
}
