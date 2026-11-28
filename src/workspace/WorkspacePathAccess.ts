import type { FileHandle } from 'node:fs/promises';

/**
 * Admits a physical filesystem route for the operation in progress. The host
 * supplies its current private paths. Passing the opened handle lets the native
 * adapter also check the object that will supply the bytes. Reacquire admission
 * when reopening a path or performing a later operation on a cached name.
 */
export interface WorkspacePathAccess {
  assertWorkspacePath(
    absolutePath: string,
    privatePaths: readonly string[],
    options?: { readonly handle?: FileHandle },
  ): Promise<void>;
}
