import { act, cleanup, renderHook } from '@testing-library/preact';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { useGlyphCodeBlockState } from '#code-oss/ui/GlyphCodeBlock/useGlyphCodeBlockState.ts';

afterEach(cleanup);

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe(useGlyphCodeBlockState, () => {
  it('highlights code in the language named by the fence info', () => {
    const { result } = renderHook(useGlyphCodeBlockState, {
      initialProps: { source: 'const a = 1;', info: '  TypeScript title="a.ts"', copyText: undefined },
    });

    expect(result.current.language).toBe('typescript');
    expect(result.current.nodes?.length).toBeGreaterThan(0);
    expect(result.current.wrap).toBe(false);
    expect(result.current.copied).toBe(false);
    expect(result.current.error).toBe(false);
  });

  it('treats code without a language as plain text', () => {
    const { result, rerender } = renderHook(useGlyphCodeBlockState, {
      initialProps: { source: 'plain', info: undefined as string | undefined, copyText: undefined },
    });
    expect(result.current.language).toBe('text');
    expect(result.current.nodes).toEqual([{ type: 'text', value: 'plain' }]);

    rerender({ source: 'plain', info: '   ', copyText: undefined });

    expect(result.current.language).toBe('text');
  });

  it('toggles line wrapping', () => {
    const { result } = renderHook(useGlyphCodeBlockState, {
      initialProps: { source: 'x', info: 'text', copyText: undefined },
    });

    act(() => result.current.toggleWrap());
    expect(result.current.wrap).toBe(true);
    act(() => result.current.toggleWrap());

    expect(result.current.wrap).toBe(false);
  });

  it('copies through the provided clipboard and confirms briefly', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const copyText = vi.fn(async () => {});
    const { result } = renderHook(useGlyphCodeBlockState, {
      initialProps: { source: 'echo hi', info: 'bash', copyText },
    });

    await act(() => result.current.copy());
    expect(copyText).toHaveBeenCalledWith('echo hi');
    expect(result.current.copied).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(result.current.copied).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(result.current.copied).toBe(false);
  });

  it('copies through the system clipboard by default', async () => {
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    onTestFinished(() => write.mockRestore());
    const { result } = renderHook(useGlyphCodeBlockState, {
      initialProps: { source: 'ls', info: 'bash', copyText: undefined },
    });

    await act(() => result.current.copy());

    expect(write).toHaveBeenCalledWith('ls');
    expect(result.current.copied).toBe(true);
  });

  it('reports copy failures and recovers on a later success', async () => {
    const copyText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce(undefined);
    const { result } = renderHook(useGlyphCodeBlockState, {
      initialProps: { source: 'ls', info: 'bash', copyText },
    });

    await act(() => result.current.copy());
    expect(result.current.error).toBe(true);
    expect(result.current.copied).toBe(false);
    await act(() => result.current.copy());

    expect(result.current.error).toBe(false);
    expect(result.current.copied).toBe(true);
  });

  it('forgets copy feedback when the code changes', async () => {
    const copyText = vi.fn(async () => {});
    const { result, rerender } = renderHook(useGlyphCodeBlockState, {
      initialProps: { source: 'one', info: 'text', copyText },
    });
    await act(() => result.current.copy());

    rerender({ source: 'two', info: 'text', copyText });

    expect(result.current.copied).toBe(false);
  });

  it('ignores copies that finish after the code changed', async () => {
    const success = deferred();
    const failure = deferred();
    const copyText = vi.fn().mockReturnValueOnce(success.promise).mockReturnValueOnce(failure.promise);
    const { result, rerender } = renderHook(useGlyphCodeBlockState, {
      initialProps: { source: 'one', info: 'text', copyText },
    });
    const copySuccess = result.current.copy();
    const copyFailure = result.current.copy();

    rerender({ source: 'two', info: 'text', copyText });
    await act(async () => {
      success.resolve();
      failure.reject(new Error('late'));
      await Promise.all([copySuccess, copyFailure]);
    });

    expect(result.current.copied).toBe(false);
    expect(result.current.error).toBe(false);
  });
});
