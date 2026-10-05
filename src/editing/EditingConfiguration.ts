export interface EditingConfiguration {
  readonly maxRawProposalBytes: number;
  readonly maxChangedBytes: number;
  readonly maxResultingBytesPerFile: number;
  readonly maxFiles: number;
  readonly maxTotalHunks: number;
  readonly maxHunksPerFile: number;
  readonly diffBudgetMs: number;
  readonly maxActiveSessions: number;
  readonly newFileBom: boolean;
  readonly newFileEol: '\n' | '\r\n' | '\r';
}
