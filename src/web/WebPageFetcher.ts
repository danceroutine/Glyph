import type { WebToolResult } from './WebToolResult.ts';

/** A bounded page read, with its final source URL and explicit truncation. */
export interface WebPageFetcher {
  fetch(url: string, signal: AbortSignal): Promise<Extract<WebToolResult, { kind: 'web_fetch' }>>;
}
