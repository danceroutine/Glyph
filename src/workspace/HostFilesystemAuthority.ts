/** Checks host-only files and directories against workspace access, including physical filesystem aliases. */
export interface HostFilesystemAuthority {
  assertHostPaths(paths: readonly string[], workspaceRoots: readonly string[]): Promise<void>;
}
