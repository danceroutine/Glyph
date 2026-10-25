import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';

/** A named workspace root whose policy-aware store can discover instruction files. */
export interface InstructionDiscoveryRoot {
  /** Workspace-root name used to qualify paths in a multi-root workspace. */
  readonly name: string;
  /** Store that enforces filesystem exclusions and symlink policy during discovery. */
  readonly disk: Pick<WorkspaceTextStore, 'list'>;
}

/**
 * Discover instruction files across workspace roots while enforcing one aggregate result limit.
 * Single-root paths stay relative; multi-root paths are qualified with their root name.
 */
export async function listInstructionFilesAcrossRoots(
  roots: readonly InstructionDiscoveryRoot[],
  maxFiles: number,
  globPattern: string,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  for (const [index, root] of roots.entries()) {
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    const result = await root.disk.list(maxFiles - files.length, globPattern);
    files.push(...result.files.map(path => (roots.length === 1 ? path : `${root.name}/${path}`)));
    truncated ||= result.truncated || (files.length >= maxFiles && index < roots.length - 1);
  }
  return { files, truncated };
}
