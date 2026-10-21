import mermaid from 'mermaid';
import { describe, expect, it, vi } from 'vitest';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));

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
  it('announces that it is ready to render', () => {
    expect(postedOnLoad).toContainEqual([{ channel: 'glyph-diagram', ready: true }, '*']);
  });

  it('renders requested diagrams with a strict configuration in the requested theme', async () => {
    vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg>dark</svg>' } as never);

    request({ channel: 'glyph-diagram', id: 'dark', source: 'graph TD; A-->B', dark: true });
    await vi.waitFor(() => expect(responses('dark')).toHaveLength(1));

    expect(posted).toHaveBeenCalledWith({ channel: 'glyph-diagram', id: 'dark', svg: '<svg>dark</svg>' }, '*');
    expect(mermaid.render).toHaveBeenCalledWith('glyph-dark', 'graph TD; A-->B');
    expect(mermaid.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ securityLevel: 'strict', startOnLoad: false, theme: 'dark', htmlLabels: false }),
    );

    vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg>light</svg>' } as never);
    request({ channel: 'glyph-diagram', id: 'light', source: 'graph LR', dark: false });
    await vi.waitFor(() => expect(responses('light')).toHaveLength(1));

    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' }));
  });

  it('refuses oversized diagrams and embedded configuration', async () => {
    vi.mocked(mermaid.render).mockClear();

    request({ channel: 'glyph-diagram', id: 'huge', source: 'A'.repeat(20001), dark: true });
    request({ channel: 'glyph-diagram', id: 'directive', source: '%%{init: {}}%%\ngraph TD', dark: true });
    request({ channel: 'glyph-diagram', id: 'frontmatter', source: 'graph TD\n---\nconfig: {}', dark: true });
    await vi.waitFor(() => expect(responses('frontmatter')).toHaveLength(1));

    for (const id of ['huge', 'directive', 'frontmatter']) {
      expect(posted).toHaveBeenCalledWith({ channel: 'glyph-diagram', id, error: true }, '*');
    }
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it('reports diagrams that fail to render', async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error('Parse error'));

    request({ channel: 'glyph-diagram', id: 'broken', source: 'graph ???', dark: true });
    await vi.waitFor(() => expect(responses('broken')).toHaveLength(1));

    expect(posted).toHaveBeenCalledWith({ channel: 'glyph-diagram', id: 'broken', error: true }, '*');
  });

  it('ignores requests from other windows and malformed requests', async () => {
    vi.mocked(mermaid.render).mockClear();
    vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg />' } as never);

    request({ channel: 'glyph-diagram', id: 'foreign', source: 'graph TD', dark: true }, new MessageChannel().port1);
    request(null);
    request({ channel: 'other', id: 'other', source: 'graph TD' });
    request({ channel: 'glyph-diagram', id: 7, source: 'graph TD' });
    request({ channel: 'glyph-diagram', id: 'no-source', source: 7 });
    request({ channel: 'glyph-diagram', id: 'valid', source: 'graph TD', dark: true });
    await vi.waitFor(() => expect(responses('valid')).toHaveLength(1));

    expect(mermaid.render).toHaveBeenCalledOnce();
    expect(responses('foreign')).toHaveLength(0);
    expect(responses('other')).toHaveLength(0);
    expect(responses('no-source')).toHaveLength(0);
  });
});
