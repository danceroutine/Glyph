import type { FileHandle } from 'node:fs/promises';

/** Filesystem authority for one workspace operation, including mounted and equivalent names. */
export interface WorkspacePathAccess {
  assertWorkspacePath(
    absolutePath: string,
    privatePaths: readonly string[],
    options?: { readonly handle?: FileHandle },
  ): Promise<void>;
}
