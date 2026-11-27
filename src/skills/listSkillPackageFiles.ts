import { readDirectoryModes } from './skillPackageInventory.ts';
import type { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import type { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';

export type SkillFileIndex = Pick<RustWorkspacePathIndex, 'refresh' | 'glob' | 'listDirectories' | 'dispose'>;
/** Open a bounded package inventory under the caller's applicable project or personal-source policy. Each
 * capture owns its index through disposal; its entries still pass through the supplied authorized workspace. */
export type OpenSkillIndex = (root: string, caseSensitive: boolean, respectGitIgnore: boolean) => SkillFileIndex;

/** Reconcile the activated package through a bounded index. Retain the owning workspace admission until the
 * temporary worker closes, so inventory from a replaced root cannot enter a later capture or mutation. */
export async function listSkillPackageFiles(
  workspace: Pick<FileSystemWorkspaceTextStore, 'resolvePath' | 'caseSensitive' | 'beginOperation'>,
  directory: string,
  openIndex: OpenSkillIndex,
  respectGitIgnore: boolean,
  signal?: AbortSignal,
) {
  const operation = workspace.beginOperation();
  const root = await workspace.resolvePath(directory);
  const index = openIndex(root, workspace.caseSensitive, respectGitIgnore);
  try {
    const state = await index.refresh(signal);
    if (state.truncated) return { files: [], directories: new Map<string, number>(), truncated: true };
    const listing = await index.glob('**/*', { limit: 257, ...(signal ? { signal } : {}) });
    const directories = await indexedPackageDirectories(
      index,
      path => workspace.resolvePath(directory + '/' + path),
      signal,
    );
    return { ...listing, directories, files: listing.files.map(path => `${directory}/${path}`) };
  } finally {
    await index.dispose();
    operation.assertCurrent();
    signal?.throwIfAborted();
  }
}

/** Reconcile empty branches through the same scoped native policy that admits package files. */
export async function indexedPackageDirectories(
  index: SkillFileIndex,
  resolve: (path: string) => Promise<string>,
  signal?: AbortSignal,
) {
  const directories = await index.listDirectories(signal);
  return readDirectoryModes(directories, resolve);
}
