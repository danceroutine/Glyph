/** Exact decoded content plus the metadata required for lossless review and revision checks. */
export interface WorkspaceTextSnapshot {
  readonly path: string;
  readonly text: string;
  readonly byteOrderMark: boolean;
  readonly revision: string;
  readonly byteLength: number;
  readonly mode: number;
  readonly identity: string;
}
