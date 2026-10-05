export interface WorkspaceTextSnapshot {
  readonly path: string;
  readonly text: string;
  readonly bom: boolean;
  readonly revision: string;
  readonly byteLength: number;
  readonly mode: number;
  readonly identity: string;
}
