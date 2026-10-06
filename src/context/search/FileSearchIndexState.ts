/** Metadata reported after starting or refreshing the native file index. */
export interface FileSearchIndexState {
  readonly root: string;
  readonly fileCount: number;
  readonly fromCache: boolean;
  readonly truncated: boolean;
  readonly durationMilliseconds: number;
}
