import { act, renderHook } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { useGlyphDecision } from '#code-oss/ui/useGlyphDecision.ts';

describe(useGlyphDecision, () => {
  it('starts idle without an error', () => {
    const { result } = renderHook(useGlyphDecision);

    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it('stays pending after a successful submission and ignores further submissions', async () => {
    const { result } = renderHook(useGlyphDecision);
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});

    await act(() => result.current.submit(first));
    await act(() => result.current.submit(second));

    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(true);
    expect(result.current.error).toBeUndefined();
  });

  it('reports a failed submission and allows another attempt', async () => {
    const { result } = renderHook(useGlyphDecision);

    await act(() =>
      result.current.submit(async () => {
        throw new Error('Offline');
      }),
    );

    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBe('Offline');

    const retry = vi.fn(async () => {});
    await act(() => result.current.submit(retry));

    expect(retry).toHaveBeenCalledOnce();
    expect(result.current.error).toBeUndefined();
  });

  it('describes failures that are not errors', async () => {
    const { result } = renderHook(useGlyphDecision);

    await act(() =>
      result.current.submit(async () => {
        throw 'denied';
      }),
    );

    expect(result.current.error).toBe('denied');
  });
});
