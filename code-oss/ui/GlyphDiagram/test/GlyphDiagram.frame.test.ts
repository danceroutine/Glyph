import mermaid from 'mermaid';
import { renderMermaidSVG } from 'beautiful-mermaid';
import { describe, expect, it, vi } from 'vitest';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));
vi.mock('beautiful-mermaid', async importOriginal => ({
  ...(await importOriginal<typeof import('beautiful-mermaid')>()),
  renderMermaidSVG: vi.fn(() => '<svg>native</svg>'),
}));

const posted = vi.spyOn(window.parent, 'postMessage');
await import('#code-oss/ui/GlyphDiagram/GlyphDiagram.frame.ts');
const postedOnLoad = [...posted.mock.calls];

function request(data: unknown, source: MessageEventSource | null = window.parent) {
  window.dispatchEvent(new MessageEvent('message', { source, data }));
}

function responses(id: string) {
  return posted.mock.calls.filter(([message]) => (message as { id?: string })?.id === id);
}

describe('GlyphDiagram.frame', () => {
  it('bounds graph complexity before invoking native layout', async () => {
    vi.mocked(renderMermaidSVG).mockClear();
    request({
      channel: 'glyph-diagram',
      id: 'dense',
      source: 'flowchart LR\n' + Array.from({ length: 201 }, (_, i) => `A --> B${i}`).join('\n'),
    });
    await vi.waitFor(() => {
      expect(responses('dense')).toHaveLength(1);
    });
    expect(renderMermaidSVG).not.toHaveBeenCalled();
    expect(posted).toHaveBeenCalledWith({ channel: 'glyph-diagram', id: 'dense', error: true }, '*');
  });
  it('announces that it is ready to render', () => {
    expect(postedOnLoad).toContainEqual([{ channel: 'glyph-diagram', ready: true }, '*']);
  });

  it('renders requested diagrams with a strict configuration in the requested theme', async () => {
    vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg>dark</svg>' } as never);

    request({ channel: 'glyph-diagram', id: 'dark', source: 'graph TD; A-->B', dark: true });
    await vi.waitFor(() => {
      expect(responses('dark')).toHaveLength(1);
    });

    expect(posted).toHaveBeenCalledWith(
      { channel: 'glyph-diagram', id: 'dark', tree: { tag: 'svg', attributes: {}, children: ['dark'] }, links: [] },
      '*',
    );
    expect(mermaid.render).toHaveBeenCalledWith('glyph-dark', 'graph TD; A-->B');
    expect(mermaid.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ securityLevel: 'strict', startOnLoad: false, theme: 'dark', htmlLabels: false }),
    );

    vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg>light</svg>' } as never);
    request({ channel: 'glyph-diagram', id: 'light', source: 'gantt', dark: false });
    await vi.waitFor(() => {
      expect(responses('light')).toHaveLength(1);
    });

    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' }));
  });

  it('refuses oversized diagrams and embedded configuration', async () => {
    vi.mocked(mermaid.render).mockClear();

    request({ channel: 'glyph-diagram', id: 'huge', source: 'A'.repeat(20001), dark: true });
    request({ channel: 'glyph-diagram', id: 'directive', source: '%%{init: {}}%%\ngraph TD', dark: true });
    request({ channel: 'glyph-diagram', id: 'frontmatter', source: 'graph TD\n---\nconfig: {}', dark: true });
    await vi.waitFor(() => {
      expect(responses('frontmatter')).toHaveLength(1);
    });

    for (const id of ['huge', 'directive', 'frontmatter']) {
      expect(posted).toHaveBeenCalledWith({ channel: 'glyph-diagram', id, error: true }, '*');
    }
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it('reports diagrams that fail to render', async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error('Parse error'));

    request({ channel: 'glyph-diagram', id: 'broken', source: 'graph ???', dark: true });
    await vi.waitFor(() => {
      expect(responses('broken')).toHaveLength(1);
    });

    expect(posted).toHaveBeenCalledWith({ channel: 'glyph-diagram', id: 'broken', error: true }, '*');
  });

  it('ignores requests from other windows and malformed requests', async () => {
    vi.mocked(mermaid.render).mockClear();
    vi.mocked(renderMermaidSVG).mockClear();
    vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg />' } as never);

    request({ channel: 'glyph-diagram', id: 'foreign', source: 'graph TD', dark: true }, new MessageChannel().port1);
    request(null);
    request({ channel: 'other', id: 'other', source: 'graph TD' });
    request({ channel: 'glyph-diagram', id: 7, source: 'graph TD' });
    request({ channel: 'glyph-diagram', id: 'no-source', source: 7 });
    request({ channel: 'glyph-diagram', id: 'valid', source: 'graph TD', dark: true });
    await vi.waitFor(() => {
      expect(responses('valid')).toHaveLength(1);
    });

    expect(renderMermaidSVG).toHaveBeenCalledOnce();
    expect(responses('foreign')).toHaveLength(0);
    expect(responses('other')).toHaveLength(0);
    expect(responses('no-source')).toHaveLength(0);
  });

  it('passes supported colors to native layout and falls back when native rendering fails', async () => {
    vi.mocked(renderMermaidSVG).mockReturnValueOnce('<svg><text>A & B</text></svg>');
    request({
      channel: 'glyph-diagram',
      id: 'colors',
      source: 'flowchart LR\nA --> B',
      colors: { bg: '#fff', fg: 42 },
    });
    await vi.waitFor(() => {
      expect(responses('colors')).toHaveLength(1);
    });
    expect(renderMermaidSVG).toHaveBeenLastCalledWith('flowchart LR\nA --> B', {
      bg: '#fff',
      font: 'system-ui',
      transparent: true,
    });
    expect(posted).toHaveBeenCalledWith(
      {
        channel: 'glyph-diagram',
        id: 'colors',
        links: [],
        tree: { tag: 'svg', attributes: {}, children: [{ tag: 'text', attributes: {}, children: ['A & B'] }] },
      },
      '*',
    );
    vi.mocked(renderMermaidSVG).mockImplementationOnce(() => {
      throw new Error('unsupported');
    });
    vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg />' } as never);
    request({ channel: 'glyph-diagram', id: 'fallback', source: 'flowchart LR\nA --> B' });
    await vi.waitFor(() => {
      expect(responses('fallback')).toHaveLength(1);
    });
    expect(mermaid.render).toHaveBeenLastCalledWith('glyph-fallback', 'flowchart LR\nA --> B');
  });

  it('rejects malformed output without preventing the next queued diagram', async () => {
    vi.mocked(renderMermaidSVG).mockReturnValueOnce('<div>&</div>').mockReturnValueOnce('<svg />');
    request({ channel: 'glyph-diagram', id: 'invalid-output', source: 'graph TD' });
    request({ channel: 'glyph-diagram', id: 'next-output', source: 'graph TD' });
    await vi.waitFor(() => {
      expect(responses('next-output')).toHaveLength(1);
    });
    expect(posted).toHaveBeenCalledWith({ channel: 'glyph-diagram', id: 'invalid-output', error: true }, '*');
    expect(posted).toHaveBeenCalledWith(
      { channel: 'glyph-diagram', id: 'next-output', tree: { tag: 'svg', attributes: {}, children: [] }, links: [] },
      '*',
    );
  });
});
