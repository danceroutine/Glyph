import { act, cleanup, renderHook, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderGlyphDiagram } from '#code-oss/ui/GlyphDiagram/GlyphDiagramRenderer.ts';
import { useGlyphDiagramState } from '#code-oss/ui/GlyphDiagram/useGlyphDiagramState.ts';

vi.mock('#code-oss/ui/GlyphDiagram/GlyphDiagramRenderer.ts', () => ({ renderGlyphDiagram: vi.fn() }));

afterEach(cleanup);

const rendering = { tree: { tag: 'svg', attributes: {}, children: ['diagram'] }, links: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe(useGlyphDiagramState, () => {
  it('renders the source as a dark diagram outside of light themes', async () => {
    vi.mocked(renderGlyphDiagram).mockResolvedValue(rendering);

    const { result } = renderHook(useGlyphDiagramState, { initialProps: { source: 'graph TD' } });

    expect(renderGlyphDiagram).toHaveBeenCalledWith('graph TD', true);
    expect(result.current.source).toBe('graph TD');
    await waitFor(() => {
      expect(result.current.rendered).toBe(true);
    });
    expect(result.current.error).toBe(false);
    expect(result.current.expanded).toBe(false);
  });

  it('replaces an existing isolated canvas without adding a second shadow root', async () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.append(document.createElement('span'));
    vi.mocked(renderGlyphDiagram).mockResolvedValue(rendering);
    renderHook(() => {
      const state = useGlyphDiagramState({ source: 'graph TD' });
      state.canvas.current = host;
      return state;
    });
    await waitFor(() => {
      expect(shadow.querySelector('svg')?.textContent).toBe('diagram');
    });
    expect(shadow.querySelector('span')).toBeNull();
  });

  it('reports diagrams that could not be rendered', async () => {
    vi.mocked(renderGlyphDiagram).mockRejectedValue(new Error('bad'));

    const { result } = renderHook(useGlyphDiagramState, { initialProps: { source: 'graph ???' } });

    await waitFor(() => {
      expect(result.current.error).toBe(true);
    });
    expect(result.current.rendered).toBe(false);
  });

  it('discards results for sources that were replaced', async () => {
    const first = deferred<typeof rendering>();
    const second = deferred<typeof rendering>();
    const third = deferred<typeof rendering>();
    vi.mocked(renderGlyphDiagram)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const { result, rerender } = renderHook(useGlyphDiagramState, { initialProps: { source: 'graph A' } });

    rerender({ source: 'graph B' });
    rerender({ source: 'graph C' });
    await act(async () => {
      first.resolve(rendering);
      second.reject(new Error('stale'));
      await Promise.allSettled([first.promise, second.promise]);
    });
    expect(result.current.rendered).toBe(false);
    expect(result.current.error).toBe(false);
    await act(async () => {
      third.resolve(rendering);
      await third.promise;
    });

    expect(result.current.rendered).toBe(true);
  });

  it('expands and collapses', () => {
    vi.mocked(renderGlyphDiagram).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(useGlyphDiagramState, { initialProps: { source: 'graph TD' } });

    act(() => {
      result.current.toggle();
    });
    expect(result.current.expanded).toBe(true);
    act(() => {
      result.current.toggle();
    });

    expect(result.current.expanded).toBe(false);
  });

  it('collapses on Escape only while expanded', () => {
    vi.mocked(renderGlyphDiagram).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(useGlyphDiagramState, { initialProps: { source: 'graph TD' } });
    act(() => {
      result.current.toggle();
    });

    const other = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    act(() => {
      window.dispatchEvent(other);
    });
    expect(result.current.expanded).toBe(true);
    expect(other.defaultPrevented).toBe(false);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    act(() => {
      window.dispatchEvent(escape);
    });

    expect(result.current.expanded).toBe(false);
    expect(escape.defaultPrevented).toBe(true);
  });
});
