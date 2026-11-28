import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphToolActivityStatus, type GlyphToolActivity } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import { WebToolName } from '#src/web/WebToolName.js';
import { GlyphWebActivity, isWebTool, webActivityResult } from '#code-oss/ui/GlyphWebActivity/GlyphWebActivity.tsx';

afterEach(cleanup);

const webTool = (overrides: Partial<GlyphToolActivity> = {}): GlyphToolActivity => ({
  id: 'tool',
  name: WebToolName.SEARCH,
  status: GlyphToolActivityStatus.COMPLETED,
  ...overrides,
});

const searchResult = (results: { title: string; url: string; snippet: string }[]) =>
  JSON.stringify({
    kind: 'web_search',
    query: 'preact',
    searchUrl: 'https://search.example/?q=preact',
    results,
    provenance: 'search_snippets_only',
  });

const fetchResult = (truncated: boolean) =>
  JSON.stringify({
    kind: 'web_fetch',
    source: { title: 'Preact', url: 'https://preactjs.com' },
    contentType: 'text/html',
    content: '<html>',
    truncated,
    provenance: 'untrusted_web_content',
  });

const summaryLabel = () => document.querySelector('summary')!.getAttribute('title');

describe(isWebTool, () => {
  it('recognizes web search and fetch tools only', () => {
    expect(isWebTool(webTool({ name: WebToolName.SEARCH }))).toBe(true);
    expect(isWebTool(webTool({ name: WebToolName.FETCH }))).toBe(true);
    expect(isWebTool(webTool({ name: 'read_file' }))).toBe(false);
  });
});

describe(webActivityResult, () => {
  it('reads a valid web result from the tool summary', () => {
    expect(webActivityResult(webTool({ summary: fetchResult(false) }))?.kind).toBe('web_fetch');
  });

  it('ignores missing, malformed and unexpected summaries', () => {
    expect(webActivityResult(webTool())).toBeUndefined();
    expect(webActivityResult(webTool({ summary: '{"kind":' }))).toBeUndefined();
    expect(webActivityResult(webTool({ summary: '{"kind":"other"}' }))).toBeUndefined();
  });
});

describe(GlyphWebActivity, () => {
  it('lists search results after the search page and opens them through the host', () => {
    const openLink = vi.fn();
    render(
      <GlyphWebActivity
        tool={webTool({
          arguments: '{"query":"preact"}',
          summary: searchResult([
            { title: 'Preact', url: 'https://preactjs.com', snippet: 'Fast 3kB React alternative' },
          ]),
        })}
        active={false}
        openLink={openLink}
      />,
    );

    expect(summaryLabel()).toBe('Searched web preact');
    const results = screen.getByRole('list', { name: 'Web search results' });
    expect([...results.querySelectorAll('a')].map(link => [link.getAttribute('aria-label'), link.textContent])).toEqual(
      [
        ['Web search results', 'Web search results'],
        ['Preact', 'PreactFast 3kB React alternative'],
      ],
    );
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: 'Preact' }));

    expect(openLink).toHaveBeenCalledWith('https://preactjs.com');
  });

  it('reports a search without results', () => {
    render(<GlyphWebActivity tool={webTool({ summary: searchResult([]) })} active={false} />);

    expect(summaryLabel()).toBe('Searched web ');
    expect(screen.getByRole('link', { name: 'Web search results' }).textContent).toContain('No results found');
  });

  it('shows a fetched page and notes truncated content', () => {
    render(
      <GlyphWebActivity
        tool={webTool({
          name: WebToolName.FETCH,
          arguments: '{"url":"https://preactjs.com"}',
          summary: fetchResult(true),
        })}
        active={false}
      />,
    );

    expect(summaryLabel()).toBe('Fetched page https://preactjs.com');
    expect(screen.getByRole('list', { name: 'Fetched page sources' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Preact' }).textContent).toBe('PreactFetched page · content truncated');
  });

  it('shows a fetched page with complete content', () => {
    render(
      <GlyphWebActivity tool={webTool({ name: WebToolName.FETCH, summary: fetchResult(false) })} active={false} />,
    );

    expect(summaryLabel()).toBe('Fetched page ');
    expect(screen.getByRole('link', { name: 'Preact' }).textContent).toBe('PreactFetched page');
  });

  it('does not open links that are not web addresses or without a host', () => {
    const openLink = vi.fn();
    const result = searchResult([{ title: 'File', url: 'ftp://files.example/a', snippet: '' }]);
    render(<GlyphWebActivity tool={webTool({ summary: result })} active={false} openLink={openLink} />);

    const link = screen.getByRole('link', { name: 'File' });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    fireEvent.click(screen.getByRole('link', { name: 'Web search results' }));
    cleanup();
    render(<GlyphWebActivity tool={webTool({ summary: result })} active={false} />);
    fireEvent.click(screen.getByRole('link', { name: 'Web search results' }));

    expect(click.defaultPrevented).toBe(true);
    expect(openLink).toHaveBeenCalledExactlyOnceWith('https://search.example/?q=preact');
  });

  it('shows a running search while the turn is active', () => {
    render(
      <GlyphWebActivity
        tool={webTool({ status: GlyphToolActivityStatus.STARTED, arguments: '{"query":"pre' })}
        active
      />,
    );

    expect(screen.getByRole('listitem').getAttribute('aria-busy')).toBe('true');
    expect(summaryLabel()).toBe('Searching web ');
    expect(screen.getByRole('status').textContent).toBe('Waiting for the result…');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('shows a running fetch while the turn is active', () => {
    render(
      <GlyphWebActivity
        tool={webTool({ name: WebToolName.FETCH, status: GlyphToolActivityStatus.STARTED, arguments: 'null' })}
        active
      />,
    );

    expect(summaryLabel()).toBe('Fetching page ');
  });

  it('ignores arguments of the wrong shape', () => {
    render(<GlyphWebActivity tool={webTool({ arguments: '{"query":1,"url":2}' })} active={false} />);

    expect(summaryLabel()).toBe('Searched web ');
  });

  it.each([
    ['was interrupted', GlyphToolActivityStatus.INTERRUPTED],
    ['was left running by an ended turn', GlyphToolActivityStatus.STARTED],
  ])('reports a request that %s as cancelled', (_, status) => {
    render(<GlyphWebActivity tool={webTool({ status, arguments: '{"query":"preact"}' })} active={false} />);

    expect(summaryLabel()).toBe('Interrupted · Searched web preact');
    expect(screen.getByRole('status').textContent).toBe('Request cancelled');
  });

  it('reports a web error with a link to open the source in the browser', () => {
    render(
      <GlyphWebActivity
        tool={webTool({
          name: WebToolName.FETCH,
          arguments: '{"url":"https://blocked.example"}',
          summary: JSON.stringify({
            kind: 'web_error',
            source: { title: 'Blocked', url: 'https://blocked.example' },
            error: { code: 'blocked', message: 'The site refused the request.' },
          }),
        })}
        active={false}
      />,
    );

    expect(summaryLabel()).toBe('Failed · Fetched page https://blocked.example');
    expect(screen.getByRole('link', { name: 'Blocked' }).textContent).toBe('BlockedOpen in your browser');
    expect(screen.getAllByRole('status').map(status => status.textContent)).toEqual(['The site refused the request.']);
  });

  it('reports a web error without a source', () => {
    render(
      <GlyphWebActivity
        tool={webTool({ summary: JSON.stringify({ kind: 'web_error', error: { code: 'x', message: 'Offline' } }) })}
        active={false}
      />,
    );

    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Offline');
  });

  it('reports a failed request with its summary or a generic message', () => {
    render(
      <GlyphWebActivity
        tool={webTool({ status: GlyphToolActivityStatus.FAILED, summary: 'Timed out' })}
        active={false}
      />,
    );
    expect(summaryLabel()).toBe('Failed · Searched web ');
    expect(screen.getByRole('status').textContent).toBe('Timed out');

    cleanup();
    render(<GlyphWebActivity tool={webTool({ status: GlyphToolActivityStatus.FAILED })} active={false} />);

    expect(screen.getByRole('status').textContent).toBe('The web request failed.');
  });

  it('notes when a finished call recorded no details', () => {
    render(<GlyphWebActivity tool={webTool({ summary: 'not json' })} active={false} />);

    expect(screen.getByRole('status').textContent).toBe('No details recorded for this call.');
  });
});
