import { ChevronDown, ChevronRight } from 'lucide-preact';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';
import type { GlyphTodoCardState } from './useGlyphTodoCardState.ts';

const styles = {
  card: css({
    flexShrink: 0,
    margin: space('none', 'lg'),
    border: tokens.border.default,
    borderRadius: tokens.card.radius,
    background: tokens.surface.pane,
    overflow: 'hidden',
  }),
  toggle: css({
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.md,
    width: '100%',
    padding: space('md', 'lg'),
    border: 0,
    background: 'transparent',
    color: tokens.text.muted,
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { background: tokens.button.quiet.hoverBackground },
    ':focus-visible': { outline: tokens.focus.ring, outlineOffset: tokens.focus.inset },
  }),
  list: css({
    margin: 0,
    padding: space('md', 'lg'),
    listStyle: 'none',
    maxHeight: 'min(280px, 30vh)',
    overflowY: 'auto',
    borderBottom: tokens.border.default,
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

export function GlyphTodoCard({ expanded, listId, summary, items, toggle }: GlyphTodoCardState) {
  return (
    <section class={`glyph-todos ${styles.card}`} aria-label="To-dos">
      {expanded && (
        <ul id={listId} class={styles.list} aria-label="Todo items">
          {items.map(item => (
            <li key={item.id} class={styles.item}>
              <svg class={styles.icon} width="16" height="16" viewBox="0 0 16 16" role="img" aria-label={item.label}>
                <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" />
                {item.path && (
                  <path
                    d={item.path}
                    fill={item.filled ? 'currentColor' : 'none'}
                    stroke={item.filled ? 'none' : 'currentColor'}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
              </svg>
              <span class={`${styles.text} ${item.status === 'completed' ? styles.completed : ''}`}>{item.text}</span>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        class={styles.toggle}
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        onClick={toggle}
      >
        {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        <span aria-live="polite">{summary}</span>
      </button>
    </section>
  );
}
