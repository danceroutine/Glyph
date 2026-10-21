import { describe, expect, it, vi } from 'vitest';
import { WebHttpClient } from '#src/web/WebHttpClient.js';
import { WebFetchService } from '#src/web/WebFetchService.js';
import { DuckDuckGoSearch } from '#src/web/DuckDuckGoSearch.js';
import { WebToolRuntime } from '#src/web/WebToolRuntime.js';
import type { WebSearchProvider } from '#src/web/WebSearchProvider.js';
import { WebRequestError } from '#src/web/WebRequestError.js';
import { webToolResultSchema } from '#src/web/WebToolResult.js';
import { webUrl } from '#src/web/WebUrl.js';

const signal = () => new AbortController().signal;
const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });

describe('Web tools', () => {
  it('preserves table column boundaries for headers, numeric values, and empty cells', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        html(
          '<main><h1>Quarterly totals</h1><table><thead><tr><th>Year</th><th>Quarter</th><th>Units</th></tr></thead><tbody><tr><td>2025</td><td>1</td><td><strong>20</strong></td></tr><tr><td>2025</td><td></td><td>30</td></tr></tbody></table></main>',
        ),
      );
    const result = await new WebFetchService(new WebHttpClient(fetcher)).fetch('https://example.com/report', signal());
    expect(result.content).toBe('Quarterly totals\nYear | Quarter | Units\n2025 | 1 | 20\n2025 | | 30');
    expect(result.truncated).toBe(false);
  });

  it.each([
    '<!doctype html><title>Fixture</title>',
    '<!doctype html><html><title>Fixture</title>',
    '<head><title>Fixture</title>',
  ])('extracts visible HTML with omitted optional document tags: %s', async prefix => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        html(
          `${prefix}<h1>Visible heading</h1><p>Visible paragraph.</p><nav>Navigation</nav><script>Never expose this</script><p hidden>Hidden text</p>`,
        ),
      );
    const result = await new WebFetchService(new WebHttpClient(fetcher)).fetch('https://example.com/page', signal());
    expect(result).toMatchObject({
      source: { title: 'Fixture' },
      content: 'Visible heading\nVisible paragraph.',
      truncated: false,
    });
  });
  it('extracts an HTML response consisting only of a text node', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html('Visible plain text.'));
    const result = await new WebFetchService(new WebHttpClient(fetcher)).fetch('https://example.com/page', signal());
    expect(result).toMatchObject({
      source: { title: 'https://example.com/page' },
      content: 'Visible plain text.',
      truncated: false,
    });
  });

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

describe(DuckDuckGoSearch, () => {
  describe(DuckDuckGoSearch.prototype.search, () => {
    it('skips ads, links without targets or titles, and redirects without destinations', async () => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          html(
            [
              '<div class="result result--ad"><a class="result__a" href="https://ads.example/">Sponsored</a></div>',
              '<div class="result"><a class="result__a">No target</a></div>',
              '<div class="result"><a class="result__a" href="https://duckduckgo.com/l/?x=1">No destination</a></div>',
              '<div class="result"><a class="result__a" href="https://example.com/blank">   </a></div>',
              '<div class="result"><a class="result__a" href="https://example.com/kept">Kept</a></div>',
            ].join(''),
          ),
        );

      const result = await new DuckDuckGoSearch(new WebHttpClient(fetcher)).search('octopus', signal());

      expect(result.results).toEqual([{ title: 'Kept', url: 'https://example.com/kept', snippet: '' }]);
      expect(result.searchUrl).toBe('https://html.duckduckgo.com/html/?q=octopus');
    });

    it('stops after five results', async () => {
      const rows = Array.from(
        { length: 7 },
        (_, index) =>
          `<div class="result"><a class="result__a" href="https://example.com/${index}">Result ${index}</a></div>`,
      ).join('');
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(rows));

      const result = await new DuckDuckGoSearch(new WebHttpClient(fetcher)).search('octopus', signal());

      expect(result.results.map(entry => entry.title)).toEqual([
        'Result 0',
        'Result 1',
        'Result 2',
        'Result 3',
        'Result 4',
      ]);
      expect(result.truncated).toBeUndefined();
    });

    it('attributes request failures to the search results page', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('denied', { status: 503 }));

      await expect(new DuckDuckGoSearch(new WebHttpClient(fetcher)).search('octopus', signal())).rejects.toMatchObject({
        code: 'HTTP_ERROR',
        source: { title: 'Web search results', url: 'https://html.duckduckgo.com/html/?q=octopus' },
      });
    });

    it('propagates cancellation unchanged', async () => {
      const reason = new Error('User cancelled');
      const fetcher = vi.fn<typeof fetch>();

      await expect(
        new DuckDuckGoSearch(new WebHttpClient(fetcher)).search('octopus', AbortSignal.abort(reason)),
      ).rejects.toBe(reason);
      expect(fetcher).not.toHaveBeenCalled();
    });
  });
});

describe(WebHttpClient, () => {
  describe(WebHttpClient.prototype.read, () => {
    it('reports an unspecified content type when the response omits it', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));

      await expect(new WebHttpClient(fetcher).read('https://example.com', signal())).rejects.toMatchObject({
        code: 'UNSUPPORTED_CONTENT',
        message: 'Unsupported page content type: unspecified.',
      });
    });

    it('decodes text with the declared charset', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
          headers: { 'content-type': 'text/plain; charset=latin1' },
        }),
      );

      await expect(new WebHttpClient(fetcher).read('https://example.com', signal())).resolves.toEqual({
        url: 'https://example.com/',
        contentType: 'text/plain',
        text: 'café',
      });
    });

    it('falls back to UTF-8 when the declared charset is unknown', async () => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('héllo', { headers: { 'content-type': 'text/plain; charset=bogus-charset' } }));

      await expect(new WebHttpClient(fetcher).read('https://example.com', signal())).resolves.toMatchObject({
        text: 'héllo',
      });
    });

    it('decodes as UTF-8 when the content type is no longer readable while decoding', async () => {
      const values = ['text/plain', null];
      const headers = { get: (name: string) => (name === 'content-type' ? (values.shift() ?? null) : null) };
      const body = new Response('héllo').body;
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue({ status: 200, ok: true, headers, body } as unknown as Response);

      await expect(new WebHttpClient(fetcher).read('https://example.com', signal())).resolves.toMatchObject({
        contentType: 'text/plain',
        text: 'héllo',
      });
    });

    it('returns empty text when the response has no body', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: null,
      } as unknown as Response);

      await expect(new WebHttpClient(fetcher).read('https://example.com', signal())).resolves.toEqual({
        url: 'https://example.com/',
        contentType: 'text/plain',
        text: '',
      });
    });

    it('still reports an oversized stream when the stream cannot be cancelled', async () => {
      const reader = {
        read: vi.fn(async () => ({ done: false, value: new Uint8Array(8) })),
        cancel: vi.fn(async () => Promise.reject(new Error('cannot cancel'))),
        releaseLock: vi.fn(),
      };
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: { getReader: () => reader },
      } as unknown as Response);

      await expect(
        new WebHttpClient(fetcher, { maxBytes: 4, timeoutMs: 20_000, maxRedirects: 1 }).read(
          'https://example.com',
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
      expect(reader.cancel).toHaveBeenCalled();
      expect(reader.releaseLock).toHaveBeenCalled();
    });

    it('reports unreachable websites as network errors', async () => {
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));

      await expect(new WebHttpClient(fetcher).read('https://example.com', signal())).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
        message: 'The website could not be reached.',
      });
    });

    it('rejects redirects without a location', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 301 }));

      await expect(new WebHttpClient(fetcher).read('https://example.com', signal())).rejects.toMatchObject({
        code: 'REDIRECT_LIMIT',
      });
    });
  });
});

describe(WebToolRuntime, () => {
  it('validates fetch and search input through its tools', () => {
    const runtime = new WebToolRuntime(
      new WebFetchService(new WebHttpClient(vi.fn<typeof fetch>())),
      new DuckDuckGoSearch(new WebHttpClient(vi.fn<typeof fetch>())),
    );
    const [fetchTool, searchTool] = runtime.tools;

    expect(() => fetchTool!.validateInput('{"url":"https://example.com"}')).not.toThrow();
    expect(() => fetchTool!.validateInput('{"url":"ftp://example.com"}')).toThrow(
      'Use an HTTP or HTTPS URL without embedded credentials.',
    );
    expect(() => fetchTool!.validateInput('{"url":"https://example.com","extra":1}')).toThrow();
    expect(() => searchTool!.validateInput('{"query":"octopus"}')).not.toThrow();
    expect(() => searchTool!.validateInput('{"query":"   "}')).toThrow();
  });

  it('includes the failing source in search error results', async () => {
    const http = new WebHttpClient(vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 })));
    const runtime = new WebToolRuntime(new WebFetchService(http), new DuckDuckGoSearch(http));
    const searchTool = runtime.tools.find(tool => tool.name === 'web_search')!;

    expect(JSON.parse(await searchTool.execute('{"query":"octopus"}', signal(), {}))).toEqual({
      kind: 'web_error',
      source: { title: 'Web search results', url: 'https://html.duckduckgo.com/html/?q=octopus' },
      error: { code: 'HTTP_ERROR', message: 'The website returned HTTP 500.' },
    });
  });

  it('reports unexpected failures generically', async () => {
    const provider: WebSearchProvider = {
      search: vi.fn<WebSearchProvider['search']>().mockRejectedValue(new Error('provider exploded')),
    };
    const runtime = new WebToolRuntime(new WebFetchService(new WebHttpClient(vi.fn<typeof fetch>())), provider);
    const searchTool = runtime.tools.find(tool => tool.name === 'web_search')!;

    expect(JSON.parse(await searchTool.execute('{"query":"octopus"}', signal(), {}))).toEqual({
      kind: 'web_error',
      error: { code: 'WEB_FAILED', message: 'The web request failed.' },
    });
  });

  it('propagates cancellation instead of returning an error result', async () => {
    const reason = new Error('User cancelled');
    const controller = new AbortController();
    const provider: WebSearchProvider = {
      search: vi.fn<WebSearchProvider['search']>().mockImplementation(async () => {
        controller.abort(reason);
        throw new Error('provider stopped');
      }),
    };
    const runtime = new WebToolRuntime(new WebFetchService(new WebHttpClient(vi.fn<typeof fetch>())), provider);
    const searchTool = runtime.tools.find(tool => tool.name === 'web_search')!;

    await expect(searchTool.execute('{"query":"octopus"}', controller.signal, {})).rejects.toBe(reason);
  });
});

describe(webUrl, () => {
  it('drops fragments from web URLs', () => {
    expect(webUrl('https://example.com/page#section').href).toBe('https://example.com/page');
  });

  it('rejects URLs longer than 2048 characters', () => {
    expect(() => webUrl(`https://example.com/${'a'.repeat(2048)}`)).toThrow(
      expect.objectContaining({ code: 'INVALID_URL', message: 'The URL exceeds 2048 characters.' }),
    );
  });

  it('rejects unparseable URLs', () => {
    expect(() => webUrl('not a url')).toThrow(WebRequestError);
  });
});

describe('webToolResultSchema', () => {
  it('accepts each result kind', () => {
    expect(
      webToolResultSchema.parse({
        kind: 'web_fetch',
        source: { title: 'Page', url: 'https://example.com' },
        contentType: 'text/html',
        content: 'Body',
        truncated: false,
        provenance: 'untrusted_web_content',
      }),
    ).toMatchObject({ kind: 'web_fetch' });
    expect(
      webToolResultSchema.parse({
        kind: 'web_search',
        query: 'octopus',
        searchUrl: 'https://search.example/?q=octopus',
        results: [{ title: 'Source', url: 'https://source.example', snippet: 'Snippet' }],
        provenance: 'search_snippets_only',
      }),
    ).toMatchObject({ kind: 'web_search' });
    expect(
      webToolResultSchema.parse({ kind: 'web_error', error: { code: 'HTTP_ERROR', message: 'Failed' } }),
    ).toMatchObject({ kind: 'web_error' });
  });

  it('rejects sources without valid URLs', () => {
    expect(() =>
      webToolResultSchema.parse({
        kind: 'web_error',
        source: { title: 'Page', url: 'not a url' },
        error: { code: 'HTTP_ERROR', message: 'Failed' },
      }),
    ).toThrow();
  });
});
