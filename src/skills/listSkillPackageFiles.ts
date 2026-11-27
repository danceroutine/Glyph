import type { WorkspacePathIndex } from '#src/context/search/WorkspacePathIndex.js';
import type { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';

/** Reconcile the activated package through a bounded index. Retain the owning workspace admission until the
 * temporary worker closes, so inventory from a replaced root cannot enter a later capture or mutation. */
export async function listSkillPackageFiles(
  workspace: Pick<FileSystemWorkspaceTextStore, 'resolvePath' | 'beginOperation'>,
  directory: string,
  createIndex: (root: string, maxFiles: number) => Pick<WorkspacePathIndex, 'refresh' | 'glob' | 'dispose'>,
  signal?: AbortSignal,
) {
  const operation = workspace.beginOperation();
  const root = await workspace.resolvePath(directory);
  const index = createIndex(root, 257);
  try {
    const state = await index.refresh(signal);
    if (state.truncated) return { files: [], truncated: true };
    const listing = await index.glob('**/*', { limit: 257, ...(signal ? { signal } : {}) });
    return { ...listing, files: listing.files.map(path => `${directory}/${path}`) };
  } finally {
    await index.dispose();
    operation.assertCurrent();
    signal?.throwIfAborted();
  }
}
