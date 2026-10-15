import type { WorkspaceTextSnapshot } from './WorkspaceTextSnapshot.ts';
import type { WorkspaceReadOptions } from './WorkspaceReadOptions.ts';
import type { WorkspaceMutationOptions } from './WorkspaceMutationOptions.ts';
import type { WorkspaceMutationConsistency } from './WorkspaceMutationConsistency.ts';

/**
 * Host-neutral project text port. Implementations provide exact snapshots and
 * revision-guarded mutations. Adapters must declare whether the revision check
 * is atomic with the mutation. A Code OSS/editor adapter must use the editor's
 * versioned mutation primitive and expose `ATOMIC_VERSIONED`; checking a
 * document version and then issuing an unrelated edit is not sufficient.
 */
export interface WorkspaceTextStore {
  readonly root: string;
  readonly caseSensitive: boolean;
  readonly mutationConsistency: WorkspaceMutationConsistency;
  list(
    maxFiles: number,
    globPattern?: string,
    targetDirectory?: string,
  ): Promise<{ files: string[]; truncated: boolean }>;
  normalizePath(path: string): string;
  /**
   * Resolves existing or prospective files to an absolute, slash-delimited path
   * for collision checks, including ancestor conflicts. Keys use the adapter's
   * filesystem casing rules; snapshot identities additionally detect hard links.
   */
  canonicalPath(path: string): Promise<string>;
  /** Checks occupancy without reading content; directories and binary files also occupy a target. */
  exists(path: string): Promise<boolean>;
  read(path: string, options?: WorkspaceReadOptions): Promise<WorkspaceTextSnapshot>;
  readOptional(path: string, options?: WorkspaceReadOptions): Promise<WorkspaceTextSnapshot | undefined>;
  create(
    path: string,
    text: string,
    byteOrderMark: boolean,
    mode?: number,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot>;
  replace(
    path: string,
    expectedRevision: string,
    text: string,
    byteOrderMark: boolean,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot>;
  rename(
    source: string,
    target: string,
    expectedRevision: string,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot>;
  delete(path: string, expectedRevision: string, options?: WorkspaceMutationOptions): Promise<void>;
}
