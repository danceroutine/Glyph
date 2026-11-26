import type { WorkspacePathIndex } from '#src/context/search/WorkspacePathIndex.js';

/** A named workspace root whose shared path index can discover instruction files. */
export interface InstructionDiscoveryRoot {
  /** Workspace-root name used to qualify paths in a multi-root workspace. */
  readonly name: string;
  /** Resident index that enforces ignore rules, filesystem exclusions, and symlink policy. */
  readonly index: Pick<WorkspacePathIndex, 'glob'>;
}

/**
 * Discover instruction files across workspace roots while enforcing one aggregate result limit.
 * Single-root paths stay relative; multi-root paths are qualified with their root name.
 * Queries reuse the host's existing watched index rather than walking each root again.
 */
export async function listInstructionFilesAcrossRoots(
  roots: readonly InstructionDiscoveryRoot[],
  maxFiles: number,
  globPattern: string,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  const qualify = (root: InstructionDiscoveryRoot, path: string) =>
    roots.length === 1 ? path : `${root.name}/${path}`;
  const agents = globPattern === '**/AGENTS.md';
  if (agents) {
    // Reserve mandatory guidance across every root before spending the shared allowance on nested files.
    for (const root of roots) {
      const result = await root.index.glob('AGENTS.md', { limit: 1, rootFilesOnly: true });
      files.push(...result.files.map(path => qualify(root, path)));
      truncated ||= result.truncated;
    }
  }
  for (const root of roots) {
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    const result = await root.index.glob(agents ? '**/?*/AGENTS.md' : globPattern, { limit: maxFiles - files.length });
    files.push(...result.files.map(path => qualify(root, path)));
    truncated ||= result.truncated;
  }
  return { files, truncated };
}
