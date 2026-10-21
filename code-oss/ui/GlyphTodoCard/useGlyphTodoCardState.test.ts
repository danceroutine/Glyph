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
      { id: 'a', text: 'Plan', status: 'completed', label: 'Completed', path: 'm5 8 2 2 4-4', filled: false },
      {
        id: 'b',
        text: 'Build',
        status: 'in_progress',
        label: 'In progress',
        path: 'M8 3a5 5 0 0 1 0 10Z',
        filled: true,
      },
      { id: 'c', text: 'Ship', status: 'pending', label: 'Pending', path: null, filled: false },
    ]);
  });

  it('expands and collapses the list', () => {
    const { result } = renderHook(useGlyphTodoCardState, { initialProps: { items: [] } });

    act(() => result.current.toggle());
    expect(result.current.expanded).toBe(true);

    act(() => result.current.toggle());
    expect(result.current.expanded).toBe(false);
  });
});
