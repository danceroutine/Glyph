import type { WebToolResult } from './WebToolResult.ts';

/** Search adapters return source snippets without fetching the linked pages. */
export interface WebSearchProvider {
  search(query: string, signal: AbortSignal): Promise<Extract<WebToolResult, { kind: 'web_search' }>>;
}
