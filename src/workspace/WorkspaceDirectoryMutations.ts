/** Identifies a directory created by a single installation. The native adapter verifies it again during rollback. */
export interface CreatedWorkspaceDirectory {
  readonly relative: string;
  readonly identity: string;
}

/** Mutations relative to a single authorized filesystem root. Renames preserve any existing destination. */
export interface WorkspaceDirectoryMutations {
  assertReplaceableMetadata(relative: string, recursive: boolean, ownershipReference?: string): Promise<string>;
  /** Creation can be limited to the approved trailing path components. The remaining parents must exist. */
  ensureDirectory(relative: string, mode?: number, createSuffixLength?: number): Promise<void>;
  /** Stage an empty directory. Journal its identity before the exclusive rename applies destination permissions. */
  stageParent(relative: string, mode: number, stagingSlot: string): Promise<CreatedWorkspaceDirectory>;
  /** Remove an empty, transaction-created parent through its private staging slot. Preserve peer additions and replacements. */
  rollbackParent(created: CreatedWorkspaceDirectory, stagingSlot: string): Promise<void>;
  createStage(relative: string): Promise<void>;
  stagePackage(
    relative: string,
    files: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly mode: number }>,
    directories: ReadonlyMap<string, number>,
  ): Promise<void>;
  renameExclusive(sourceRelative: string, targetRelative: string): Promise<void>;
  removeTree(relative: string): Promise<void>;
}
