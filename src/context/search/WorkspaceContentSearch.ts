export type WorkspaceContentSearchPatternKind = 'regular_expression' | 'literal';

export type WorkspaceContentSearchOutputMode = 'content' | 'files_with_matches' | 'count';

/**
 * Provider-neutral content-query contract for the resident workspace index.
 * The index selects safe candidate paths while implementations read current
 * bytes at query time, so callers do not depend on stale cached contents.
 */
export interface WorkspaceContentSearchOptions {
  readonly patternKind: WorkspaceContentSearchPatternKind;
  readonly path?: string;
  readonly fileGlob?: string;
  readonly fileType?: string;
  readonly outputMode: WorkspaceContentSearchOutputMode;
  readonly linesBefore: number;
  readonly linesAfter: number;
  readonly caseSensitive: boolean;
  readonly multiline: boolean;
  readonly limit: number;
  readonly offset: number;
  readonly signal?: AbortSignal;
}

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
