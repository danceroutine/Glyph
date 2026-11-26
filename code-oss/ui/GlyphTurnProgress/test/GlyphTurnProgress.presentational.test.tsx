import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphToolActivityStatus, type GlyphToolActivity } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import { WebToolName } from '#src/web/WebToolName.js';
import { GlyphTurnProgress } from '#code-oss/ui/GlyphTurnProgress/GlyphTurnProgress.presentational.tsx';

afterEach(cleanup);

const tool = (overrides: Partial<GlyphToolActivity> = {}): GlyphToolActivity => ({
  id: 'tool',
  name: 'read_file',
  status: GlyphToolActivityStatus.COMPLETED,
  ...overrides,
});

const summaries = () => [...document.querySelectorAll('summary')].map(summary => summary.getAttribute('title'));

describe(GlyphTurnProgress, () => {
  it('discloses the reasoning summary', () => {
    render(
      <GlyphTurnProgress
        progress={{ status: GlyphRunStatus.COMPLETED, reasoning: 'Thinking it through', tools: [] }}
      />,
    );

    const region = screen.getByRole('region', { name: 'Turn progress' });
    expect(region.querySelector('.glyph-reasoning summary')?.textContent).toBe('Reasoning summary');
    expect(region.querySelector('.glyph-reasoning p')?.textContent).toBe('Thinking it through');
  });

  it('shows nothing without reasoning or tools', () => {
    render(<GlyphTurnProgress progress={{ status: GlyphRunStatus.COMPLETED, reasoning: '', tools: [] }} />);

    expect(screen.getByRole('region', { name: 'Turn progress' }).childElementCount).toBe(0);
  });

  it('shows a finished tool with its formatted arguments and result', () => {
    render(
      <GlyphTurnProgress
        progress={{
          status: GlyphRunStatus.COMPLETED,
          reasoning: '',
          tools: [tool({ arguments: '{"path":"a.ts"}', summary: 'plain result' })],
        }}
      />,
    );

    const row = screen.getByRole('listitem');
    expect(row.dataset.toolId).toBe('tool');
    expect(row.getAttribute('aria-busy')).toBe('false');
    expect(summaries()).toEqual(['Read file']);
    expect(row.querySelector('pre')?.textContent).toBe('{\n  "path": "a.ts"\n}\n\nplain result');
    expect(row.querySelector('.glyph-tool-status')?.textContent).toBe('Finished');
    expect(document.querySelector('.glyph-tool-group')).toBeNull();
  });

  it.each([
    [
      'running in an active turn',
      GlyphRunStatus.STREAMING,
      GlyphToolActivityStatus.STARTED,
      'Running read file',
      'Running',
      'Waiting for the result…',
    ],
    [
      'waiting on a question',
      GlyphRunStatus.WAITING_FOR_QUESTION,
      GlyphToolActivityStatus.STARTED,
      'Running read file',
      'Running',
      'Waiting for the result…',
    ],
    [
      'waiting on an approval',
      GlyphRunStatus.WAITING_FOR_APPROVAL,
      GlyphToolActivityStatus.STARTED,
      'Running read file',
      'Running',
      'Waiting for the result…',
    ],
    [
      'left running by an ended turn',
      GlyphRunStatus.CANCELLED,
      GlyphToolActivityStatus.STARTED,
      'Interrupted · read file',
      'Interrupted',
      'No details recorded for this call.',
    ],
    [
      'interrupted',
      GlyphRunStatus.INTERRUPTED,
      GlyphToolActivityStatus.INTERRUPTED,
      'Interrupted · read file',
      'Interrupted',
      'No details recorded for this call.',
    ],
    [
      'failed',
      GlyphRunStatus.FAILED,
      GlyphToolActivityStatus.FAILED,
      'Run attempted · read file',
      'Failed',
      'No details recorded for this call.',
    ],
  ])('labels a tool that is %s', (_, runStatus, toolStatus, label, status, body) => {
    render(
      <GlyphTurnProgress progress={{ status: runStatus, reasoning: '', tools: [tool({ status: toolStatus })] }} />,
    );

    const row = screen.getByRole('listitem');
    expect(summaries()).toEqual([label]);
    expect(row.getAttribute('aria-busy')).toBe(String(status === 'Running'));
    expect(row.querySelector('.glyph-tool-status')?.textContent).toBe(status);
    expect(row.querySelector('pre')?.textContent).toBe(body);
  });

  it('groups consecutive tools called at the same point of the reply', () => {
    render(
      <GlyphTurnProgress
        progress={{
          status: GlyphRunStatus.COMPLETED,
          reasoning: '',
          tools: [
            tool({ id: 'a', textOffset: 0 }),
            tool({ id: 'b', textOffset: 0, name: 'list_dir' }),
            tool({ id: 'c', textOffset: 10 }),
          ],
        }}
      />,
    );

    const group = document.querySelector('.glyph-tool-group')!;
    expect(group.querySelector('summary')?.textContent).toBe('Explored2 tools');
    expect(group.querySelector('summary .lucide-wrench')).toBeTruthy();
    expect([...group.querySelectorAll('li')].map(row => row.dataset.toolId)).toEqual(['a', 'b']);
    expect(screen.getAllByRole('list', { name: 'Tool activity' })).toHaveLength(2);
  });

  it('summarizes a group of web activity while it runs', () => {
    const openLink = vi.fn();
    render(
      <GlyphTurnProgress
        openLink={openLink}
        progress={{
          status: GlyphRunStatus.STREAMING,
          reasoning: '',
          tools: [
            tool({ id: 'a', name: WebToolName.SEARCH, status: GlyphToolActivityStatus.STARTED }),
            tool({
              id: 'b',
              name: WebToolName.FETCH,
              summary: JSON.stringify({
                kind: 'web_fetch',
                source: { title: 'Preact', url: 'https://preactjs.com' },
                contentType: 'text/html',
                content: '',
                truncated: false,
                provenance: 'untrusted_web_content',
              }),
            }),
          ],
        }}
      />,
    );

    const group = document.querySelector('.glyph-tool-group')!;
    expect(group.querySelector('summary')?.textContent).toBe('Exploring1 search, 1 fetch');
    expect(group.querySelector('summary .lucide-globe')).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Preact' }));

    expect(openLink).toHaveBeenCalledWith('https://preactjs.com');
  });

  it('counts failed tools and web errors in a group', () => {
    render(
      <GlyphTurnProgress
        progress={{
          status: GlyphRunStatus.COMPLETED,
          reasoning: '',
          tools: [
            tool({ id: 'a', status: GlyphToolActivityStatus.FAILED }),
            tool({
              id: 'b',
              name: WebToolName.SEARCH,
              summary: JSON.stringify({ kind: 'web_error', error: { code: 'x', message: 'Offline' } }),
            }),
            tool({ id: 'c', name: WebToolName.SEARCH }),
            tool({ id: 'd', status: GlyphToolActivityStatus.INTERRUPTED }),
          ],
        }}
      />,
    );

    expect(document.querySelector('.glyph-tool-group summary')?.textContent).toBe(
      'Explored2 searches, 2 tools · 2 failed',
    );
  });

  it.each([
    ['interrupted', GlyphRunStatus.COMPLETED, GlyphToolActivityStatus.INTERRUPTED],
    ['left running by an ended turn', GlyphRunStatus.CANCELLED, GlyphToolActivityStatus.STARTED],
  ])('marks a group with a tool that was %s', (_, runStatus, toolStatus) => {
    render(
      <GlyphTurnProgress
        progress={{
          status: runStatus,
          reasoning: '',
          tools: [
            tool({ id: 'a', name: WebToolName.FETCH }),
            tool({ id: 'b', name: WebToolName.FETCH, status: toolStatus }),
          ],
        }}
      />,
    );

    expect(document.querySelector('.glyph-tool-group summary')?.textContent).toBe('Explored2 fetches · interrupted');
  });
});
