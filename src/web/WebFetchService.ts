import { parseHTML } from 'linkedom';
import type { WebHttpClient } from './WebHttpClient.ts';
import type { WebToolResult } from './WebToolResult.ts';
import type { WebPageFetcher } from './WebPageFetcher.ts';

export class WebFetchService implements WebPageFetcher {
  constructor(private readonly http: WebHttpClient) {}

  async fetch(url: string, signal: AbortSignal): Promise<Extract<WebToolResult, { kind: 'web_fetch' }>> {
    const page = await this.http.read(url, signal);
    let title = page.url;
    let content = page.text;
    if (['text/html', 'application/xhtml+xml'].includes(page.contentType)) {
      const { document } = parseHTML(page.text);
      title = document.querySelector('title')?.textContent?.trim() || page.url;
      for (const node of document.querySelectorAll(
        'title,script,style,noscript,template,nav,header,footer,form,[hidden],[aria-hidden="true"]',
      ))
        node.remove();
      // LinkeDOM does not infer omitted document wrappers like a browser does.
      // Its body getter can create an empty body or throw for a text-only page.
      const root = document.querySelector('main,article') ?? document.querySelector('body') ?? document;
      for (const row of root.querySelectorAll('tr')) {
        const cells = Array.from(row.children).filter(cell => cell.matches('td,th'));
        for (const cell of cells.slice(1)) cell.insertBefore(document.createTextNode(' | '), cell.firstChild);
      }
      // Preserve paragraph, heading, table-row, and code-block boundaries in plain text.
      for (const node of root.querySelectorAll('p,div,section,li,h1,h2,h3,h4,h5,h6,pre,tr,br'))
        node.appendChild(document.createTextNode('\n'));
      content = Array.from(root.childNodes, node => node.textContent ?? '')
        .join('')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n/g, '\n\n')
        .trim();
    }
    signal.throwIfAborted();
    const result: Extract<WebToolResult, { kind: 'web_fetch' }> = {
      kind: 'web_fetch',
      source: { url: page.url, title: title.slice(0, 200) },
      contentType: page.contentType,
      content: content.slice(0, 8000),
      truncated: content.length > 8000,
      provenance: 'untrusted_web_content',
    };
    // Keep durable activity JSON intact under the transcript's 16,000-character preview bound.
    while (JSON.stringify(result).length > 14_000) {
      result.content = result.content.slice(0, Math.floor(result.content.length / 2));
      result.truncated = true;
    }
    return result;
  }
}
