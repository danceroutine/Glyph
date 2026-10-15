import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphAccountPicker } from './GlyphAccountPicker.tsx';
import { css, tokens, space, conditions } from './design-system/index.ts';

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

export function GlyphChatHistory({
  state,
  actions,
  onOpened,
}: {
  readonly state: GlyphWorkbenchState;
  readonly actions: GlyphWorkbenchViewActions;
  readonly onOpened: () => void;
}) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => search.current?.focus(), []);
  const chats = [...state.chats]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .filter(chat => chat.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const week = new Date(today);
  week.setDate(week.getDate() - 7);
  const groups = [
    { label: 'Today', chats: chats.filter(chat => Date.parse(chat.updatedAt) >= today.getTime()) },
    {
      label: 'Previous 7 days',
      chats: chats.filter(
        chat => Date.parse(chat.updatedAt) < today.getTime() && Date.parse(chat.updatedAt) >= week.getTime(),
      ),
    },
    { label: 'Older', chats: chats.filter(chat => Date.parse(chat.updatedAt) < week.getTime()) },
  ];
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
        <button
          class={styles.newChat}
          type="button"
          disabled={state.navigationPending || state.readOnly}
          onClick={() => {
            actions.newChat();
            onOpened();
          }}
        >
          ＋ New chat
        </button>
      </div>
      <nav class={styles.list} aria-label="Saved chats" aria-busy={!!state.navigationPending}>
        {groups.map(
          group =>
            group.chats.length > 0 && (
              <section key={group.label} aria-label={group.label}>
                <h3 class={styles.group}>{group.label}</h3>
                {group.chats.map(chat => {
                  const active = state.runs.some(
                    run =>
                      run.chatId === chat.id &&
                      [
                        GlyphRunStatus.STREAMING,
                        GlyphRunStatus.WAITING_FOR_QUESTION,
                        GlyphRunStatus.WAITING_FOR_APPROVAL,
                      ].includes(run.status),
                  );
                  return (
                    <button
                      key={chat.id}
                      class={styles.item}
                      type="button"
                      aria-current={state.selectedChatId === chat.id ? 'true' : undefined}
                      title={chat.title}
                      onClick={() => {
                        void actions.openChat(chat.id).then(onOpened);
                      }}
                    >
                      <span class={styles.activity} aria-label={active ? 'Running' : undefined}>
                        {active ? '◌' : '○'}
                      </span>
                      {chat.title}
                    </button>
                  );
                })}
              </section>
            ),
        )}
        {chats.length === 0 && (
          <p class={styles.empty}>{query ? 'No matching chats.' : 'Your conversations will appear here.'}</p>
        )}
      </nav>
      <GlyphAccountPicker state={state} actions={actions} />
    </aside>
  );
}
