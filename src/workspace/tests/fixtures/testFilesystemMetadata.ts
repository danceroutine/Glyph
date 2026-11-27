import type { FilesystemMetadata } from '#src/workspace/FilesystemMetadata.js';
import type { WorkspacePathAccess } from '#src/workspace/WorkspacePathAccess.js';
import type { HostFilesystemAuthority } from '#src/workspace/HostFilesystemAuthority.js';

/** Storage unit fixtures supply a metadata-free filesystem unless a test models another policy. */
export const testFilesystemMetadata: FilesystemMetadata & HostFilesystemAuthority & WorkspacePathAccess = {
  assertWorkspacePath: async () => {},
  inspect: async () => {},
  assertHostPaths: async () => {},
};
