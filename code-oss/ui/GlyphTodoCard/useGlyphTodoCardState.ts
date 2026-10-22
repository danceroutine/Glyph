import { useId, useState } from 'preact/hooks';
import type { GlyphTodoItem } from '#src/desktop/protocol/events/GlyphTodoItem.js';

const TODO_STATUS_DISPLAY = {
  pending: { label: 'Pending', path: null, filled: false },
  in_progress: { label: 'In progress', path: 'M8 3a5 5 0 0 1 0 10Z', filled: true },
  completed: { label: 'Completed', path: 'm5 8 2 2 4-4', filled: false },
} as const satisfies Record<
  GlyphTodoItem['status'],
  { readonly label: string; readonly path: string | null; readonly filled: boolean }
>;

export interface GlyphTodoCardStateOptions {
  readonly items: readonly GlyphTodoItem[];
}

export type GlyphTodoCardState = ReturnType<typeof useGlyphTodoCardState>;

export function useGlyphTodoCardState({ items }: GlyphTodoCardStateOptions) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const completed = items.filter(item => item.status === 'completed').length;
  return {
    expanded,
    listId,
    summary: `${completed} of ${items.length} To-dos completed`,
    items: items.map(item => ({ ...item, ...TODO_STATUS_DISPLAY[item.status] })),
    toggle: () => {
      setExpanded(value => !value);
    },
  };
}
