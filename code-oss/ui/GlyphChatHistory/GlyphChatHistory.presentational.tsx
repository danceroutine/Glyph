import { Button, ButtonAppearance } from '#code-oss/ui/Button/Button.tsx';
import type { GlyphChatHistoryState } from './useGlyphChatHistoryState.ts';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';
import type { ComponentChildren } from 'preact';

const styles = {
  newChatLayout: css({ width: '100%', justifyContent: 'flex-start' }),
  root: css({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    boxSizing: 'border-box',
    width: tokens.history.columnWidth,
    flexShrink: 0,
    background: tokens.surface.pane,
    borderLeft: tokens.border.default,
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

  list: css({ flex: 1, minHeight: 0, overflowY: 'auto', padding: space('none', 'lg', 'lg') }),
  group: css({
    margin: space('lg', 'md', 'sm'),
    fontSize: tokens.font.size.caption,
    fontWeight: tokens.font.weight.medium,
    color: tokens.text.muted,
  }),
  item: css({
    '&&': {
      display: 'block',
      width: '100%',
      textAlign: 'left',
      padding: space('md', 'md'),
      margin: space('xxs', 'none'),
      border: 0,
      borderRadius: tokens.list.radius,
      color: tokens.text.primary,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    },
    '&&[aria-current="true"]': {
      background: tokens.list.selected.background,
      color: tokens.list.selected.foreground,
    },
    ':focus-visible': { outlineOffset: tokens.focus.inset },
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
        <Button
          appearance={ButtonAppearance.GHOST}
          class={styles.newChatLayout}
          type="button"
          disabled={newChatDisabled}
          onClick={newChat}
        >
          ＋ New chat
        </Button>
      </div>
      <nav class={styles.list} aria-label="Saved chats" aria-busy={navigationPending}>
        {groups.map(
          group =>
            group.chats.length > 0 && (
              <section key={group.label} aria-label={group.label}>
                <h3 class={styles.group}>{group.label}</h3>
                {group.chats.map(chat => (
                  <Button
                    appearance={ButtonAppearance.GHOST}
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
                  </Button>
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
