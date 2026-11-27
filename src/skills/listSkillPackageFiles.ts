import { readDirectoryModes } from './skillPackageInventory.ts';
import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import type { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';

/** Reconcile only the activated package's bounded inventory so a newly added resource cannot be omitted by watcher lag. */
export async function listSkillPackageFiles(
  workspace: Pick<FileSystemWorkspaceTextStore, 'resolvePath' | 'caseSensitive'>,
  directory: string,
  binaryPath: string,
  respectGitIgnore: boolean,
  signal?: AbortSignal,
) {
  const root = await workspace.resolvePath(directory);
  const index = new RustWorkspacePathIndex({
    root,
    binaryPath,
    caseSensitive: workspace.caseSensitive,
    maxFiles: 257,
    respectGitIgnore,
  });
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
  }
}

/** Reconcile empty branches through the same scoped native policy that admits package files. */
export async function indexedPackageDirectories(
  index: RustWorkspacePathIndex,
  resolve: (path: string) => Promise<string>,
  signal?: AbortSignal,
) {
  const directories = await index.listDirectories(signal);
  return readDirectoryModes(directories, resolve);
}
