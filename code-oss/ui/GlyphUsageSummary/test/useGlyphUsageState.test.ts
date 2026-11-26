import { act, renderHook } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import { useGlyphUsageState } from '#code-oss/ui/GlyphUsageSummary/useGlyphUsageState.ts';

describe(useGlyphUsageState, () => {
  it('starts closed at the default position', () => {
    const { result } = renderHook(useGlyphUsageState);

    expect(result.current.open).toBe(false);
    expect(result.current.position).toEqual({ left: 8, top: 8 });
    expect(result.current.id).toBeTruthy();
  });

  it('toggles open without moving when it has nothing to anchor to', () => {
    const { result } = renderHook(useGlyphUsageState);

    act(() => {
      result.current.toggle();
    });
    expect(result.current.open).toBe(true);
    expect(result.current.position).toEqual({ left: 8, top: 8 });

    act(() => {
      result.current.toggle();
    });
    expect(result.current.open).toBe(false);
  });
});
