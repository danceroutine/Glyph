/** Exact path matches returned from the shared workspace index. */
export interface WorkspacePathGlobResult {
  readonly files: string[];
  readonly truncated: boolean;
}
