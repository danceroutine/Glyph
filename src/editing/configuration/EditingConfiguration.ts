export interface EditingConfiguration {
  readonly maxRawProposalBytes: number;
  readonly maxChangedBytes: number;
  readonly maxResultingBytesPerFile: number;
  readonly maxFiles: number;
  readonly maxTotalHunks: number;
  readonly maxHunksPerFile: number;
  readonly diffBudgetMs: number;
  readonly maxActiveReviews: number;
  readonly newFileByteOrderMark: boolean;
  readonly newFileLineEnding: '\n' | '\r\n' | '\r';
}
