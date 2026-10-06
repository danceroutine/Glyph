import type { FileSearchIndexState } from './FileSearchIndexState.ts';
import type { FileSearchResult } from './FileSearchResult.ts';

/**
 * Host-neutral port for a long-lived project file index. Terminal and future
 * editor hosts use this without depending on the Rust transport or ranking
 * implementation.
 */
export interface WorkspaceFileSearch {
  initialize(signal?: AbortSignal): Promise<FileSearchIndexState>;
  /**
   * Searches the resident index. Generations are scoped to this long-lived
   * instance and must increase as the host issues newer queries; the worker
   * uses them to abandon superseded work.
   */
  search(
    query: string,
    options: { generation: number; limit?: number; signal?: AbortSignal },
  ): Promise<FileSearchResult>;
  refresh(signal?: AbortSignal): Promise<FileSearchIndexState>;
  dispose(): Promise<void>;
}
