import type { FileSearchMatch } from './FileSearchMatch.ts';

/** Results for one generation of an incremental file-name search. */
export interface FileSearchResult {
  readonly generation: number;
  readonly query: string;
  readonly fileCount: number;
  readonly matches: readonly FileSearchMatch[];
}
