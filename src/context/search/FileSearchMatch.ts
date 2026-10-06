/** A ranked project-relative path returned by the workspace file index. */
export interface FileSearchMatch {
  readonly path: string;
  readonly score: number;
  /** Unicode code-point positions that contributed to the fuzzy match. */
  readonly indices: readonly number[];
}
