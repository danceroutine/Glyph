import { realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { NativeFilesystemMetadata } from '#src/workspace/NativeFilesystemMetadata.js';
import type { FilesystemMetadata } from '#src/workspace/FilesystemMetadata.js';
import type { WorkspacePathAccess } from '#src/workspace/WorkspacePathAccess.js';
import type { HostFilesystemAuthority } from '#src/workspace/HostFilesystemAuthority.js';

/** Storage unit fixtures supply a metadata-free filesystem unless a test models another policy. */
export const testFilesystemMetadata: FilesystemMetadata &
  HostFilesystemAuthority &
  WorkspacePathAccess &
  Pick<NativeFilesystemMetadata, 'sourceOrigins' | 'assertUnlinkedDirectory'> = {
  sourceOrigins: async (paths, _privatePaths, _signal, directories) =>
    Promise.all(
      paths.map(async path => {
        const physical = await realpath(path);
        const entry = await stat(physical, { bigint: true });
        const parent = await stat(dirname(physical), { bigint: true });
        const identity = `${entry.dev}:${entry.ino}`;
        return { identity, origin: directories ? identity : `${physical}:${parent.ino}` };
      }),
    ),
  assertUnlinkedDirectory: async () => {
    throw new Error('A native directory probe is required for a removed fixture source.');
  },
  assertWorkspacePath: async () => {},
  inspect: async () => {},
  assertHostPaths: async () => {},
};
