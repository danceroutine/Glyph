export interface WorkspaceContentSearchLine {
  readonly number: number;
  readonly content: string;
}

export interface WorkspaceContentMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly lineText: string;
  readonly matchedText: string;
  readonly linesBefore: readonly WorkspaceContentSearchLine[];
  readonly linesAfter: readonly WorkspaceContentSearchLine[];
}

export interface WorkspaceContentSearchMetadata {
  readonly searchedFiles: number;
  readonly skippedFiles: number;
  readonly indexTruncated: boolean;
  readonly truncated: boolean;
  readonly nextOffset: number | null;
}

export interface WorkspaceContentMatchesResult extends WorkspaceContentSearchMetadata {
  readonly outputMode: 'content';
  readonly matches: readonly WorkspaceContentMatch[];
}

export interface WorkspaceFilesWithMatchesResult extends WorkspaceContentSearchMetadata {
  readonly outputMode: 'files_with_matches';
  readonly files: readonly string[];
}

export interface WorkspaceContentCountResult extends WorkspaceContentSearchMetadata {
  readonly outputMode: 'count';
  readonly counts: readonly { readonly path: string; readonly count: number }[];
}

export type WorkspaceContentSearchResult =
  WorkspaceContentMatchesResult | WorkspaceFilesWithMatchesResult | WorkspaceContentCountResult;
