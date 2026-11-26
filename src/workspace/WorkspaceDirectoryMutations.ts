/** Mutations relative to a single authorized filesystem root. Renames preserve any existing destination. */
export interface WorkspaceDirectoryMutations {
  ensureDirectory(relative: string): Promise<void>;
  renameExclusive(sourceRelative: string, targetRelative: string): Promise<void>;
  removeTree(relative: string): Promise<void>;
}
