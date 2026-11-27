import type { WorkspaceAccessPolicy } from '#src/workspace/policy/WorkspaceAccessPolicy.js';
import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import type { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';

/** Reconcile only the activated package's bounded inventory so a newly added resource cannot be omitted by watcher lag. */
export async function listSkillPackageFiles(
  workspace: Pick<FileSystemWorkspaceTextStore, 'resolvePath' | 'caseSensitive'>,
  directory: string,
  binaryPath: string,
  respectGitIgnore: boolean,
  signal?: AbortSignal,
  accessPolicy?: WorkspaceAccessPolicy,
) {
  const root = await workspace.resolvePath(directory);
  const index = new RustWorkspacePathIndex({
    root,
    ...(accessPolicy ? { accessPolicy } : {}),
    binaryPath,
    caseSensitive: workspace.caseSensitive,
    maxFiles: 257,
    respectGitIgnore,
  });
  try {
    const state = await index.refresh(signal);
    if (state.truncated) return { files: [], truncated: true };
    const listing = await index.glob('**/*', { limit: 257, ...(signal ? { signal } : {}) });
    return { ...listing, files: listing.files.map(path => `${directory}/${path}`) };
  } finally {
    await index.dispose();
  }
}
