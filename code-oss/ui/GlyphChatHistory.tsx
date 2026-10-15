import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphAccountPicker } from './GlyphAccountPicker.tsx';
import { css } from './emotion.ts';

const styles = {
  root: css({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    width: 'min(100%, 280px)',
    position: 'absolute',
    inset: '0 0 0 auto',
    zIndex: 2,
    background: 'var(--vscode-sideBar-background)',
    borderLeft: '1px solid var(--vscode-panel-border)',
    boxShadow: '-4px 0 12px var(--vscode-widget-shadow)',
    '@container (min-width: 680px)': { position: 'static', flex: '0 0 260px', width: 260, boxShadow: 'none' },
  }),
  top: css({ padding: 12, display: 'grid', gap: 10 }),
  search: css({
    boxSizing: 'border-box',
    width: '100%',
    minWidth: 0,
    padding: '8px 10px',
    borderRadius: 6,
    font: 'inherit',
    color: 'var(--vscode-input-foreground)',
    background: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    ':focus-visible': { outline: '1px solid var(--vscode-focusBorder)' },
  }),
  newChat: css({
    textAlign: 'left',
    padding: '7px 8px',
    border: 0,
    borderRadius: 4,
    cursor: 'pointer',
    font: 'inherit',
    color: 'var(--vscode-foreground)',
    background: 'transparent',
    ':hover': { background: 'var(--vscode-list-hoverBackground)' },
  }),
  list: css({ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 12px 12px' }),
  group: css({ margin: '14px 8px 6px', fontSize: 11, fontWeight: 500, color: 'var(--vscode-descriptionForeground)' }),
  item: css({
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '9px 8px',
    margin: '2px 0',
    border: 0,
    borderRadius: 5,
    cursor: 'pointer',
    font: 'inherit',
    color: 'var(--vscode-foreground)',
    background: 'transparent',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    ':hover': { background: 'var(--vscode-list-hoverBackground)' },
    '&[aria-current="true"]': {
      background: 'var(--vscode-list-activeSelectionBackground)',
      color: 'var(--vscode-list-activeSelectionForeground)',
    },
    ':focus-visible': { outline: '1px solid var(--vscode-focusBorder)', outlineOffset: -1 },
  }),
  activity: css({ display: 'inline-block', width: 16, color: 'var(--vscode-descriptionForeground)' }),
  empty: css({ padding: 8, color: 'var(--vscode-descriptionForeground)' }),
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
