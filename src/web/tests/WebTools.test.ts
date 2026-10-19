import { describe, expect, it, vi } from 'vitest';
import { WebHttpClient } from '#src/web/WebHttpClient.js';
import { WebFetchService } from '#src/web/WebFetchService.js';
import { DuckDuckGoSearch } from '#src/web/DuckDuckGoSearch.js';
import { WebToolRuntime } from '#src/web/WebToolRuntime.js';
import type { WebSearchProvider } from '#src/web/WebSearchProvider.js';

const signal = () => new AbortController().signal;
const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });

describe('Web tools', () => {
  it('follows redirects anonymously, extracts text without script content, and cites the final URL', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/article' } }))
      .mockResolvedValueOnce(
        html(
          '<html><head><title>Octopus &amp; ocean</title></head><body><nav>Navigation</nav><main><h1>Giant octopus</h1><p>Eight arms.</p><script>throw new Error("never run")</script></main></body></html>',
        ),
      );
    const result = await new WebFetchService(new WebHttpClient(fetcher)).fetch('https://example.com/start', signal());
    expect(result).toMatchObject({
      source: { title: 'Octopus & ocean', url: 'https://example.com/article' },
      content: 'Giant octopus\nEight arms.',
      truncated: false,
      provenance: 'untrusted_web_content',
    });
    for (const [, options] of fetcher.mock.calls) {
      expect(options?.credentials).toBe('omit');
      expect(new Headers(options?.headers).has('authorization')).toBe(false);
      expect(new Headers(options?.headers).has('cookie')).toBe(false);
    }
  });
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'https://user:secret@example.com/'])(
    'rejects non-web or credential URLs: %s',
    async url => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(new WebHttpClient(fetcher).read(url, signal())).rejects.toMatchObject({ code: 'INVALID_URL' });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('validates redirect destinations and caps redirect loops', async () => {
    await expect(
      new WebHttpClient(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'file:///private' } })),
      ).read('https://example.com', signal()),
    ).rejects.toMatchObject({ code: 'INVALID_URL' });
    const loop = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/loop' } }));
    await expect(new WebHttpClient(loop).read('https://example.com', signal())).rejects.toMatchObject({
      code: 'REDIRECT_LIMIT',
    });
    expect(loop).toHaveBeenCalledTimes(6);
  });
  it.each([
    [() => new Response('denied', { status: 403 }), 'HTTP_ERROR'],
    [() => new Response('pdf', { headers: { 'content-type': 'application/pdf' } }), 'UNSUPPORTED_CONTENT'],
    [
      () => new Response('large', { headers: { 'content-type': 'text/plain', 'content-length': '1048577' } }),
      'RESPONSE_TOO_LARGE',
    ],
    [() => new Response('x'.repeat(1048577), { headers: { 'content-type': 'text/plain' } }), 'RESPONSE_TOO_LARGE'],
  ])('reports HTTP, content type and streamed byte limit errors', async (response, code) => {
    await expect(
      new WebHttpClient(vi.fn<typeof fetch>().mockResolvedValue(response())).read('https://example.com', signal()),
    ).rejects.toMatchObject({ code });
  });
  it('bounds extracted text and preserves parseable activity for escaped content', async () => {
    const result = await new WebFetchService(
      new WebHttpClient(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('\u0000'.repeat(20000), { headers: { 'content-type': 'text/plain' } })),
      ),
    ).fetch('https://example.com', signal());
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(14000);
  });
  it('cancels an in-flight response and distinguishes timeouts', async () => {
    const fetcher: typeof fetch = (_input, options) =>
      new Promise((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }),
      );
    const controller = new AbortController();
    const pending = new WebHttpClient(fetcher).read('https://example.com', controller.signal);
    controller.abort(new Error('User cancelled'));
    await expect(pending).rejects.toThrow('User cancelled');
    await expect(
      new WebHttpClient(fetcher, { timeoutMs: 10, maxBytes: 100, maxRedirects: 2 }).read(
        'https://example.com',
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
  it('returns deduplicated search snippets and decoded source URLs without fetching the source', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        html(
          '<html><body><div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Foctopus">Giant &amp; deep</a><a class="result__snippet">Search excerpt only</a></div><div class="result"><a class="result__a" href="https://example.com/octopus">Duplicate</a></div><div class="result"><a class="result__a" href="javascript:alert(1)">Unsafe</a></div></body></html>',
        ),
      );
    const result = await new DuckDuckGoSearch(new WebHttpClient(fetcher)).search('largest octopus', signal());
    expect(result).toMatchObject({
      provenance: 'search_snippets_only',
      results: [{ title: 'Giant & deep', url: 'https://example.com/octopus', snippet: 'Search excerpt only' }],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('distinguishes empty results from blocked and unrecognized search pages', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(html('<div class="no-results">No results</div>'))
      .mockResolvedValueOnce(html('<form id="challenge-form"></form>'))
      .mockResolvedValueOnce(html('<div>Unexpected page</div>'));
    const search = new DuckDuckGoSearch(new WebHttpClient(fetcher));
    expect((await search.search('none', signal())).results).toEqual([]);
    await expect(search.search('blocked', signal())).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
    await expect(search.search('changed', signal())).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
  });
  it('keeps large search source lists parseable in the persisted transcript', async () => {
    const rows = Array.from(
      { length: 5 },
      (_, index) =>
        `<div class="result"><a class="result__a" href="https://example.com/${index}${'x'.repeat(1900)}">${'"'.repeat(200)}</a><span class="result__snippet">${'"'.repeat(300)}</span></div>`,
    ).join('');
    const result = await new DuckDuckGoSearch(
      new WebHttpClient(vi.fn<typeof fetch>().mockResolvedValue(html(rows))),
    ).search('octopus', signal());
    expect(result.truncated).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(14000);
  });
  it('advertises source boundaries in both modes and returns explicit errors as tool results', async () => {
    const http = new WebHttpClient(vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 })));
    const tools = new WebToolRuntime(new WebFetchService(http), new DuckDuckGoSearch(http)).tools;
    for (const tool of tools) {
      expect(tool.allowedModes).toEqual(['agent', 'plan']);
      expect(tool.description).toContain('untrusted source data');
    }
    const output = await tools[0]!.execute('{"url":"https://example.com"}', signal(), {});
    expect(JSON.parse(output)).toMatchObject({ kind: 'web_error', error: { code: 'HTTP_ERROR' } });
  });
  it('uses an injected search provider without selecting an adapter or making its own HTTP request', async () => {
    const provider: WebSearchProvider = {
      search: vi.fn<WebSearchProvider['search']>().mockResolvedValue({
        kind: 'web_search',
        query: 'octopus',
        searchUrl: 'https://search.example/?q=octopus',
        results: [{ title: 'Source', url: 'https://source.example', snippet: 'Provider snippet' }],
        provenance: 'search_snippets_only',
      }),
    };
    const network = vi.fn<typeof fetch>();
    const runtime = new WebToolRuntime(new WebFetchService(new WebHttpClient(network)), provider);
    const tool = runtime.tools.find(tool => tool.name === 'web_search')!;
    const cancellation = signal();
    const result = JSON.parse(await tool.execute('{"query":"octopus"}', cancellation, {}));
    expect(provider.search).toHaveBeenCalledWith('octopus', cancellation);
    expect(result.searchUrl).toBe('https://search.example/?q=octopus');
    expect(result.results[0].snippet).toBe('Provider snippet');
    expect(network).not.toHaveBeenCalled();
    expect(tool.description).not.toContain('DuckDuckGo');
  });
});
