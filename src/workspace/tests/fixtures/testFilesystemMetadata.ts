import type { FilesystemMetadata } from '#src/workspace/FilesystemMetadata.js';
import type { HostFilesystemAuthority } from '#src/workspace/HostFilesystemAuthority.js';

/** Storage unit fixtures supply a metadata-free filesystem unless a test models another policy. */
export const testFilesystemMetadata: FilesystemMetadata & HostFilesystemAuthority = {
  inspect: async () => {},
  assertHostPaths: async () => {},
};
