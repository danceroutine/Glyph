import type { GlyphTodoItem } from '#src/desktop/protocol/events/GlyphTodoItem.js';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';

const TODO_STATUS_DISPLAY = {
  pending: { label: 'Pending', path: null, filled: false },
  in_progress: { label: 'In progress', path: 'M8 3a5 5 0 0 1 0 10Z', filled: true },
  completed: { label: 'Completed', path: 'm5 8 2 2 4-4', filled: false },
} as const satisfies Record<
  GlyphTodoItem['status'],
  { readonly label: string; readonly path: string | null; readonly filled: boolean }
>;

const styles = {
  list: css({
    margin: 0,
    padding: space('md', 'lg'),
    listStyle: 'none',
    maxHeight: 'min(280px, 30vh)',
    overflowY: 'auto',
  }),
  item: css({
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.space.md,
    padding: space('sm', 'none'),
    fontSize: tokens.font.size.body,
    color: tokens.text.primary,
  }),
  text: css({ flex: 1, minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', userSelect: 'text' }),
  completed: css({ color: tokens.text.muted, textDecoration: 'line-through' }),
  icon: css({ color: tokens.text.muted, flexShrink: 0 }),
};

export function GlyphTodoStatusIcon({
  status,
  class: className,
}: {
  readonly status: GlyphTodoItem['status'];
  readonly class?: string;
}) {
  const display = TODO_STATUS_DISPLAY[status];
  return (
    <svg
      class={`${styles.icon} ${className ?? ''}`}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      role="img"
      aria-label={display.label}
    >
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" />
      {display.path && (
        <path
          d={display.path}
          fill={display.filled ? 'currentColor' : 'none'}
          stroke={display.filled ? 'none' : 'currentColor'}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export function GlyphTodoList({
  id,
  items,
  class: className,
}: {
  readonly id?: string;
  readonly items: readonly GlyphTodoItem[];
  readonly class?: string;
}) {
  return (
    <ul id={id} class={`${styles.list} ${className ?? ''}`} aria-label="Todo items">
      {items.map(item => (
        <li key={item.id} class={styles.item}>
          <GlyphTodoStatusIcon status={item.status} />
          <span class={`${styles.text} ${item.status === 'completed' ? styles.completed : ''}`}>{item.text}</span>
        </li>
      ))}
    </ul>
  );
}
