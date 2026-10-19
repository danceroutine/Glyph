import { parseHTML } from 'linkedom';
import type { WebHttpClient } from './WebHttpClient.ts';
import { webUrl } from './WebUrl.ts';
import { WebRequestError } from './WebRequestError.ts';
import type { WebToolResult } from './WebToolResult.ts';
import type { WebSearchProvider } from './WebSearchProvider.ts';

/** No-key HTML search. Challenge and changed-result pages fail explicitly instead of pretending no results exist. */
export class DuckDuckGoSearch implements WebSearchProvider {
  constructor(private readonly http: WebHttpClient) {}

  async search(query: string, signal: AbortSignal): Promise<Extract<WebToolResult, { kind: 'web_search' }>> {
    const searchUrl = new URL('https://html.duckduckgo.com/html/');
    searchUrl.searchParams.set('q', query);
    try {
      return await this.read(query, searchUrl, signal);
    } catch (error) {
      if (error instanceof WebRequestError)
        throw new WebRequestError(error.code, error.message, { title: 'Web search results', url: searchUrl.href });
      throw error;
    }
  }

  private async read(
    query: string,
    searchUrl: URL,
    signal: AbortSignal,
  ): Promise<Extract<WebToolResult, { kind: 'web_search' }>> {
    const page = await this.http.read(searchUrl.href, signal);
    const { document } = parseHTML(page.text);
    if (document.querySelector('#challenge-form, .anomaly-modal, form[action*="anomaly.js"]'))
      throw new WebRequestError(
        'SEARCH_UNAVAILABLE',
        'DuckDuckGo requested a browser verification. Open the search in your browser or try again later.',
      );
    const results: Extract<WebToolResult, { kind: 'web_search' }>['results'] = [];
    const seen = new Set<string>();
    for (const row of document.querySelectorAll('.result')) {
      if (row.classList.contains('result--ad')) continue;
      const link = row.querySelector('a.result__a');
      const href = link?.getAttribute('href');
      if (!href) continue;
      let url: URL;
      try {
        url = new URL(href, page.url);
        if (['duckduckgo.com', 'html.duckduckgo.com'].includes(url.hostname) && url.pathname === '/l/')
          url = webUrl(url.searchParams.get('uddg') ?? '');
        else url = webUrl(url.href);
      } catch {
        continue;
      }
      if (seen.has(url.href)) continue;
      const title = link?.textContent?.trim();
      if (!title) continue;
      seen.add(url.href);
      results.push({
        title: title.slice(0, 200),
        url: url.href,
        snippet: (row.querySelector('.result__snippet')?.textContent ?? '').trim().slice(0, 300),
      });
      if (results.length === 5) break;
    }
    if (!results.length && !document.querySelector('.no-results, .result--no-result'))
      throw new WebRequestError(
        'SEARCH_UNAVAILABLE',
        'DuckDuckGo did not return a recognized results page. Try again later.',
      );
    signal.throwIfAborted();
    const result: Extract<WebToolResult, { kind: 'web_search' }> = {
      kind: 'web_search',
      query,
      searchUrl: searchUrl.href,
      results,
      provenance: 'search_snippets_only',
    };
    // Preserve complete source records in the bounded, persisted transcript preview.
    while (JSON.stringify(result).length > 14_000 && results.length > 1) {
      results.pop();
      result.truncated = true;
    }
    return result;
  }
}
