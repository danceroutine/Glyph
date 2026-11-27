/** Mutations relative to a single authorized filesystem root. Renames preserve any existing destination. */
export interface WorkspaceDirectoryMutations {
  assertReplaceableMetadata(relative: string, recursive: boolean, ownershipReference?: string): Promise<string>;
  ensureDirectory(relative: string, mode?: number): Promise<void>;
  createStage(relative: string): Promise<void>;
  stagePackage(
    relative: string,
    files: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly mode: number }>,
    directories: ReadonlyMap<string, number>,
  ): Promise<void>;
  renameExclusive(sourceRelative: string, targetRelative: string): Promise<void>;
  removeTree(relative: string): Promise<void>;
}
