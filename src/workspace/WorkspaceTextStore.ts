import type { WorkspaceTextSnapshot } from './WorkspaceTextSnapshot.ts';
import type { WorkspaceMutationOptions } from './WorkspaceMutationOptions.ts';

export interface WorkspaceTextStore {
  readonly root: string;
  readonly caseSensitive: boolean;
  list(maxFiles: number): Promise<{ files: string[]; truncated: boolean }>;
  normalizePath(path: string): string;
  read(path: string): Promise<WorkspaceTextSnapshot>;
  readOptional(path: string): Promise<WorkspaceTextSnapshot | undefined>;
  create(path: string, text: string, bom: boolean, mode?: number, options?: WorkspaceMutationOptions): Promise<WorkspaceTextSnapshot>;
  replace(path: string, expectedRevision: string, text: string, bom: boolean, options?: WorkspaceMutationOptions): Promise<WorkspaceTextSnapshot>;
  rename(source: string, target: string, expectedRevision: string, options?: WorkspaceMutationOptions): Promise<WorkspaceTextSnapshot>;
  delete(path: string, expectedRevision: string, options?: WorkspaceMutationOptions): Promise<void>;
}
