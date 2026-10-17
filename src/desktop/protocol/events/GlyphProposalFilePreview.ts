/** Requested on demand; full file contents do not travel in reconnect snapshots. */
export interface GlyphProposalFilePreview {
  readonly proposalId: string;
  readonly fileId: string;
  readonly before: string;
  readonly after: string;
  readonly items: readonly { readonly id: string; readonly lineNumber: number }[];
}
