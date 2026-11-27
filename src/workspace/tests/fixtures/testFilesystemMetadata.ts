import type { FilesystemMetadata } from '#src/workspace/FilesystemMetadata.js';

/** Storage unit fixtures supply a metadata-free filesystem unless a test models another policy. */
export const testFilesystemMetadata: FilesystemMetadata = { inspect: async () => {} };
