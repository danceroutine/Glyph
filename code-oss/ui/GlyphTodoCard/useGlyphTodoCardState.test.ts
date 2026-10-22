import { act, renderHook } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import { useGlyphTodoCardState } from '#code-oss/ui/GlyphTodoCard/useGlyphTodoCardState.ts';

describe(useGlyphTodoCardState, () => {
  it('summarizes completed todos and describes each status', () => {
    const { result } = renderHook(useGlyphTodoCardState, {
      initialProps: {
        items: [
          { id: 'a', text: 'Plan', status: 'completed' as const },
          { id: 'b', text: 'Build', status: 'in_progress' as const },
          { id: 'c', text: 'Ship', status: 'pending' as const },
        ],
      },
    });

    expect(result.current.summary).toBe('1 of 3 To-dos completed');
    expect(result.current.expanded).toBe(false);
    expect(result.current.listId).toBeTruthy();
    expect(result.current.items).toEqual([
      { id: 'a', text: 'Plan', status: 'completed' },
      {
        id: 'b',
        text: 'Build',
        status: 'in_progress',
      },
      { id: 'c', text: 'Ship', status: 'pending' },
    ]);
  });

  it('expands and collapses the list', () => {
    const { result } = renderHook(useGlyphTodoCardState, { initialProps: { items: [] } });

    act(() => {
      result.current.toggle();
    });
    expect(result.current.expanded).toBe(true);

    act(() => {
      result.current.toggle();
    });
    expect(result.current.expanded).toBe(false);
  });
});
