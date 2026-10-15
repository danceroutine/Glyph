import type { GlyphChatHistoryState } from './useGlyphChatHistoryState.ts';
import { css, tokens, space, conditions } from '../design-system/index.ts';
import type { ComponentChildren } from 'preact';

const styles = {
  root: css({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    width: tokens.history.drawerWidth,
    maxWidth: '100%',
    position: 'absolute',
    inset: '0 0 0 auto',
    zIndex: tokens.history.layer,
    background: tokens.surface.pane,
    borderLeft: tokens.border.default,
    boxShadow: tokens.history.shadow,
    [conditions.widePane]: {
      position: 'static',
      flexShrink: 0,
      width: tokens.history.columnWidth,
      boxShadow: 'none',
    },
  }),
  top: css({ padding: tokens.space.lg, display: 'grid', gap: tokens.space.md }),
  search: css({
    boxSizing: 'border-box',
    width: '100%',
    minWidth: 0,
    padding: space('md', 'md'),
    borderRadius: tokens.input.radius,
    font: 'inherit',
    color: tokens.input.foreground,
    background: tokens.input.background,
    border: tokens.input.strongBorder,
    ':focus-visible': { outline: tokens.focus.ring },
  }),
  newChat: css({
    textAlign: 'left',
    padding: space('md', 'md'),
    border: 0,
    borderRadius: tokens.list.radius,
    cursor: 'pointer',
    font: 'inherit',
    color: tokens.text.primary,
    background: 'transparent',
    ':hover': { background: tokens.list.hoverBackground },
  }),
  list: css({ flex: 1, minHeight: 0, overflowY: 'auto', padding: space('none', 'lg', 'lg') }),
  group: css({
    margin: space('lg', 'md', 'sm'),
    fontSize: tokens.font.size.caption,
    fontWeight: tokens.font.weight.medium,
    color: tokens.text.muted,
  }),
  item: css({
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: space('md', 'md'),
    margin: space('xxs', 'none'),
    border: 0,
    borderRadius: tokens.list.radius,
    cursor: 'pointer',
    font: 'inherit',
    color: tokens.text.primary,
    background: 'transparent',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    ':hover': { background: tokens.list.hoverBackground },
    '&[aria-current="true"]': {
      background: tokens.list.selected.background,
      color: tokens.list.selected.foreground,
    },
    ':focus-visible': { outline: tokens.focus.ring, outlineOffset: tokens.focus.inset },
  }),
  activity: css({ display: 'inline-block', width: 16, color: tokens.text.muted }),
  empty: css({ padding: tokens.space.md, color: tokens.text.muted }),
};

export type GlyphChatHistoryProps = GlyphChatHistoryState & { readonly accountControl: ComponentChildren };

export function GlyphChatHistory({
  query,
  setQuery,
  search,
  groups,
  emptyMessage,
  newChatDisabled,
  navigationPending,
  newChat,
  openChat,
  accountControl,
}: GlyphChatHistoryProps) {
  return (
    <aside id="glyph-chat-history" class={`glyph-chat-history ${styles.root}`} aria-label="Chat history">
      <div class={styles.top}>
        <input
          ref={search}
          class={styles.search}
          type="search"
          aria-label="Search chats"
          placeholder="Search chats…"
          value={query}
          onInput={event => setQuery(event.currentTarget.value)}
        />
        <button class={styles.newChat} type="button" disabled={newChatDisabled} onClick={newChat}>
          ＋ New chat
        </button>
      </div>
      <nav class={styles.list} aria-label="Saved chats" aria-busy={navigationPending}>
        {groups.map(
          group =>
            group.chats.length > 0 && (
              <section key={group.label} aria-label={group.label}>
                <h3 class={styles.group}>{group.label}</h3>
                {group.chats.map(chat => (
                  <button
                    key={chat.id}
                    class={styles.item}
                    type="button"
                    aria-current={chat.selected ? 'true' : undefined}
                    title={chat.title}
                    onClick={() => openChat(chat.id)}
                  >
                    <span class={styles.activity} aria-label={chat.active ? 'Running' : undefined}>
                      {chat.active ? '◌' : '○'}
                    </span>
                    {chat.title}
                  </button>
                ))}
              </section>
            ),
        )}
        {emptyMessage && <p class={styles.empty}>{emptyMessage}</p>}
      </nav>
      {accountControl}
    </aside>
  );
}
