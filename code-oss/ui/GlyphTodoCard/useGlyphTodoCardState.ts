import { useId, useState } from 'preact/hooks';
import type { GlyphTodoItem } from '#src/desktop/protocol/events/GlyphTodoItem.js';

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
    items,
    toggle: () => setExpanded(value => !value),
  };
}
