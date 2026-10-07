/** Customizable exclusions shared by every workspace-reading capability. */
export interface WorkspaceAccessPolicyOptions {
  readonly ignoredDirectories?: readonly string[];
  readonly sensitiveFileNames?: readonly string[];
  readonly sensitiveFilePrefixes?: readonly string[];
  readonly sensitiveFileExtensions?: readonly string[];
  readonly allowedFileNames?: readonly string[];
}
