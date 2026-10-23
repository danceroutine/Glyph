import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { configureGlyphDiagramRenderer, renderGlyphDiagram } from '#code-oss/ui/GlyphDiagram/GlyphDiagramRenderer.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let instances = 0;

async function freshRenderer(): Promise<typeof import('#code-oss/ui/GlyphDiagram/GlyphDiagramRenderer.ts')> {
  const module = new URL('./GlyphDiagramRenderer.ts', import.meta.url);
  module.searchParams.set('instance', String(++instances));
  return import(module.href) as Promise<typeof import('#code-oss/ui/GlyphDiagram/GlyphDiagramRenderer.ts')>;
}

function latestFrame(): HTMLIFrameElement {
  const frame = [...document.querySelectorAll('iframe')].at(-1)!;
  onTestFinished(() => {
    frame.remove();
  });
  return frame;
}

function reply(frame: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
}

describe(renderGlyphDiagram, () => {
  it('loads an isolated, hidden renderer document', async () => {
    const renderer = await freshRenderer();
    renderer.configureGlyphDiagramRenderer('about:blank#diagram');

    renderer.renderGlyphDiagram('graph TD', true).catch(() => {});

    const frame = latestFrame();
    expect(frame.getAttribute('src')).toBe('about:blank#diagram');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    expect(frame.tabIndex).toBe(-1);
    expect(frame.style.visibility).toBe('hidden');
    expect(frame.style.position).toBe('fixed');
  });

  it('resolves rendered diagrams as SVG image data', async () => {
    const renderer = await freshRenderer();
    renderer.configureGlyphDiagramRenderer('about:blank');
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('0-0-0-0-1');

    const rendered = renderer.renderGlyphDiagram('graph TD', false);
    const frame = latestFrame();
    reply(frame, { channel: 'glyph-diagram', ready: true });
    await vi.waitFor(() => {
      expect(crypto.randomUUID).toHaveBeenCalled();
    });
    reply(frame, { channel: 'glyph-diagram', id: '0-0-0-0-1', svg: '<svg>A & B</svg>' });

    await expect(rendered).resolves.toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg>A & B</svg>')}`);
  });

  it('reuses one renderer for every diagram', async () => {
    const renderer = await freshRenderer();
    renderer.configureGlyphDiagramRenderer('about:blank');
    const ids = vi.spyOn(crypto, 'randomUUID');
    ids.mockReturnValueOnce('0-0-0-0-1').mockReturnValueOnce('0-0-0-0-2');

    const first = renderer.renderGlyphDiagram('graph TD', true);
    const frame = latestFrame();
    const second = renderer.renderGlyphDiagram('graph LR', true);
    reply(frame, { channel: 'glyph-diagram', ready: true });
    await vi.waitFor(() => {
      expect(ids).toHaveBeenCalledTimes(2);
    });
    reply(frame, { channel: 'glyph-diagram', id: '0-0-0-0-2', svg: '<svg>2</svg>' });
    reply(frame, { channel: 'glyph-diagram', id: '0-0-0-0-1', svg: '<svg>1</svg>' });

    await expect(first).resolves.toContain(encodeURIComponent('<svg>1</svg>'));
    await expect(second).resolves.toContain(encodeURIComponent('<svg>2</svg>'));
    expect(document.querySelectorAll('iframe[src="about:blank"]')).toHaveLength(1);
  });

  it('ignores messages that do not belong to its renderer', async () => {
    const renderer = await freshRenderer();
    renderer.configureGlyphDiagramRenderer('about:blank');
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('0-0-0-0-1');

    const rendered = renderer.renderGlyphDiagram('graph TD', true);
    const frame = latestFrame();
    window.dispatchEvent(
      new MessageEvent('message', { source: window, data: { channel: 'glyph-diagram', ready: true } }),
    );
    reply(frame, null);
    reply(frame, { channel: 'other', ready: true });
    reply(frame, { channel: 'glyph-diagram', ready: true });
    await vi.waitFor(() => {
      expect(crypto.randomUUID).toHaveBeenCalled();
    });
    reply(frame, { channel: 'glyph-diagram', id: 7, svg: '<svg>x</svg>' });
    reply(frame, { channel: 'glyph-diagram', id: 'unknown', svg: '<svg>x</svg>' });
    reply(frame, { channel: 'glyph-diagram', id: '0-0-0-0-1', svg: '<svg>ok</svg>' });

    await expect(rendered).resolves.toContain(encodeURIComponent('<svg>ok</svg>'));
  });

  it('rejects diagrams the renderer could not draw', async () => {
    const renderer = await freshRenderer();
    renderer.configureGlyphDiagramRenderer('about:blank');
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('0-0-0-0-1');

    const rendered = renderer.renderGlyphDiagram('nonsense', true);
    const frame = latestFrame();
    reply(frame, { channel: 'glyph-diagram', ready: true });
    await vi.waitFor(() => {
      expect(crypto.randomUUID).toHaveBeenCalled();
    });
    reply(frame, { channel: 'glyph-diagram', id: '0-0-0-0-1', error: true });

    await expect(rendered).rejects.toMatchObject({
      name: 'GlyphDiagramError',
      message: 'Unable to render this diagram.',
    });
  });

  it('gives up when the renderer never loads', async () => {
    vi.useFakeTimers();
    const renderer = await freshRenderer();
    renderer.configureGlyphDiagramRenderer('about:blank');

    const rendered = renderer.renderGlyphDiagram('graph TD', true);
    latestFrame();
    const outcome = expect(rendered).rejects.toMatchObject({
      name: 'GlyphDiagramError',
      message: 'The diagram renderer did not load.',
    });
    vi.advanceTimersByTime(15000);

    await outcome;
  });

  it('gives up when a diagram takes too long to render', async () => {
    vi.useFakeTimers();
    const renderer = await freshRenderer();
    renderer.configureGlyphDiagramRenderer('about:blank');
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('0-0-0-0-1');

    const rendered = renderer.renderGlyphDiagram('graph TD', true);
    const frame = latestFrame();
    reply(frame, { channel: 'glyph-diagram', ready: true });
    await vi.waitFor(() => {
      expect(crypto.randomUUID).toHaveBeenCalled();
    });
    const outcome = expect(rendered).rejects.toMatchObject({
      name: 'GlyphDiagramError',
      message: 'Diagram rendering timed out.',
    });
    vi.advanceTimersByTime(15000);
    await outcome;
    reply(frame, { channel: 'glyph-diagram', id: '0-0-0-0-1', svg: '<svg>late</svg>' });
  });
});

describe(configureGlyphDiagramRenderer, () => {
  it('serves the renderer from the configured address', async () => {
    configureGlyphDiagramRenderer('about:blank#configured');

    renderGlyphDiagram('graph TD', true).catch(() => {});

    expect(latestFrame().getAttribute('src')).toBe('about:blank#configured');
  });
});
