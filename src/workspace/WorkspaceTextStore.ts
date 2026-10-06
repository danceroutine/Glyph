import type { WorkspaceTextSnapshot } from './WorkspaceTextSnapshot.ts';
import type { WorkspaceMutationOptions } from './WorkspaceMutationOptions.ts';

/**
 * Host-neutral project text port. Implementations provide exact snapshots and
 * revision-guarded mutations; a filesystem and a future VS Code workspace can
 * therefore share proposal and review behavior.
 */
export interface WorkspaceTextStore {
  readonly root: string;
  readonly caseSensitive: boolean;
  list(
    maxFiles: number,
    globPattern?: string,
    targetDirectory?: string,
  ): Promise<{ files: string[]; truncated: boolean }>;
  normalizePath(path: string): string;
  read(path: string): Promise<WorkspaceTextSnapshot>;
  readOptional(path: string): Promise<WorkspaceTextSnapshot | undefined>;
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
