/** Initialization options understood by the version-one Rust index protocol. */
export interface RustWorkspaceFileSearchOptions {
  readonly binaryPath: string;
  readonly root: string;
  readonly cachePath?: string;
  readonly ignoredDirectories?: readonly string[];
  /** Project-relative files or directory subtrees omitted from the native index. */
  readonly excludedPaths?: readonly string[];
  readonly sensitiveFileNames?: readonly string[];
  readonly sensitiveFilePrefixes?: readonly string[];
  readonly sensitiveFileExtensions?: readonly string[];
  readonly allowedFileNames?: readonly string[];
  readonly respectGitIgnore?: boolean;
  readonly maxFiles?: number;
}
