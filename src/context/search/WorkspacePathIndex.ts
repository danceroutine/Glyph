import type { FileSearchResult } from './FileSearchResult.ts';
import type { WorkspaceContentSearchOptions } from './WorkspaceContentSearchOptions.ts';
import type { WorkspaceContentSearchResult } from './WorkspaceContentSearchResult.ts';
import type { WorkspacePathGlobResult } from './WorkspacePathGlobResult.ts';
import type { WorkspacePathIndexState } from './WorkspacePathIndexState.ts';

/**
 * Host-neutral port for the long-lived workspace path catalog. Agent-facing
 * exact discovery and human-facing fuzzy attachment search share one cached,
 * watched index without depending on its Rust transport or matchers.
 */
export interface WorkspacePathIndex {
  initialize(signal?: AbortSignal): Promise<WorkspacePathIndexState>;
  /**
   * Fuzzy-searches the resident index for interactive attachment completion.
   * Generations are scoped to this long-lived
   * instance and must increase as the host issues newer queries; the worker
   * uses them to abandon superseded work.
   */
  search(
    query: string,
    options: { generation: number; limit?: number; signal?: AbortSignal },
  ): Promise<FileSearchResult>;
  /** Finds exact glob matches without walking the filesystem again. */
  glob(
    pattern: string,
    options: { targetDirectory?: string; limit: number; signal?: AbortSignal },
  ): Promise<WorkspacePathGlobResult>;
  /** Searches current file contents across paths selected from the resident catalog. */
  searchContents(pattern: string, options: WorkspaceContentSearchOptions): Promise<WorkspaceContentSearchResult>;
  refresh(signal?: AbortSignal): Promise<WorkspacePathIndexState>;
  dispose(): Promise<void>;
}
