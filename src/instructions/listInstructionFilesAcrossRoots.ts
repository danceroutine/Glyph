import type { WorkspacePathIndex } from '#src/context/search/WorkspacePathIndex.js';

/** A named workspace root whose shared path index can discover instruction files. */
export interface InstructionDiscoveryRoot {
  /** Workspace-root name used to qualify paths in a multi-root workspace. */
  readonly name: string;
  /** Resident index that enforces ignore rules, filesystem exclusions, and symlink policy. */
  readonly index: Pick<WorkspacePathIndex, 'glob'>;
}

export interface InstructionFileListing {
  readonly files: string[];
  readonly truncated: boolean;
  readonly failures?: readonly { readonly path: string; readonly message: string }[];
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
  qualifyPaths = roots.length > 1,
  signal?: AbortSignal,
): Promise<InstructionFileListing> {
  signal?.throwIfAborted();
  const files: string[] = [];
  let truncated = false;
  const failures = new Map<InstructionDiscoveryRoot, string>();
  const qualify = (root: InstructionDiscoveryRoot, path: string) => (qualifyPaths ? `${root.name}/${path}` : path);
  const agents = globPattern === '**/AGENTS.md';
  if (agents) {
    // Reserve mandatory guidance across every root before spending the shared allowance on nested files.
    for (const root of roots) {
      try {
        const result = await root.index.glob('AGENTS.md', { limit: 1, rootFilesOnly: true, ...(signal && { signal }) });
        signal?.throwIfAborted();
        if (result.truncated) throw new Error('Root guidance lookup is incomplete.');
        files.push(...result.files.map(path => qualify(root, path)));
      } catch (error) {
        signal?.throwIfAborted();
        failures.set(root, error instanceof Error ? error.message : 'Root guidance lookup failed.');
      }
    }
  }
  for (const root of roots) {
    if (failures.has(root)) continue;
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    try {
      const result = await root.index.glob(agents ? '**/?*/AGENTS.md' : globPattern, {
        limit: maxFiles - files.length,
        ...(signal && { signal }),
      });
      signal?.throwIfAborted();
      files.push(...result.files.map(path => qualify(root, path)));
      truncated ||= result.truncated;
    } catch (error) {
      signal?.throwIfAborted();
      if (!agents) throw error;
      failures.set(root, error instanceof Error ? error.message : 'Nested guidance lookup failed.');
    }
  }
  return {
    files,
    truncated,
    ...(failures.size > 0
      ? { failures: [...failures].map(([root, message]) => ({ path: qualify(root, 'AGENTS.md'), message })) }
      : {}),
  };
}
