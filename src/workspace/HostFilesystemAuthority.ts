/**
 * Verifies that the host's executable, staging or configuration paths remain
 * outside all supplied workspace roots, including physical filesystem aliases.
 * Host operations fetch current roots and repeat this check before subprocess
 * launch or private storage access.
 */
export interface HostFilesystemAuthority {
  assertHostPaths(paths: readonly string[], workspaceRoots: readonly string[]): Promise<void>;
}
