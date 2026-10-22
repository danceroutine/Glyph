import { Button, ButtonAppearance, ButtonSize, IconButton } from '#code-oss/ui/Button/Button.tsx';
import { GlyphSidebarIcon } from '#code-oss/ui/GlyphSidebarIcon/GlyphSidebarIcon.tsx';
import type { GlyphChatHistoryState } from './useGlyphChatHistoryState.ts';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Pin, PinOff } from 'lucide-preact';
import type { ComponentChildren, Ref } from 'preact';

const styles = {
  newChatLayout: css({ '&&': { width: '100%', justifyContent: 'flex-start' } }),
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
  toolbar: css({
    height: 35,
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingRight: tokens.space.xs,
    flexShrink: 0,
  }),
  row: css({
    display: 'flex',
    alignItems: 'center',
    borderRadius: tokens.list.radius,
    margin: space('xxs', 'none'),
    '&:hover, &:focus-within': { background: tokens.list.hoverBackground },
    '&[data-selected]': { background: tokens.list.selected.background, color: tokens.list.selected.foreground },
    '& > .chat-row-actions': { display: 'none' },
    '&:hover > .chat-row-actions, &:focus-within > .chat-row-actions': { display: 'flex' },
  }),
  compact: css({ '&&': { width: '100%', maxHeight: 400, border: 0, background: 'transparent' } }),
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
      flex: 1,
      minWidth: 0,
      textAlign: 'left',
      padding: space('md', 'md'),
      border: 0,
      borderRadius: tokens.list.radius,
      color: tokens.text.primary,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    },
    '&&[aria-current="true"]': { color: tokens.list.selected.foreground },
    ':focus-visible': { outlineOffset: tokens.focus.inset },
  }),
  activity: css({ display: 'inline-block', width: 16, color: tokens.text.muted }),
  empty: css({ padding: tokens.space.md, color: tokens.text.muted }),
};

export type GlyphChatHistoryProps = GlyphChatHistoryState & {
  readonly accountControl: ComponentChildren;
  readonly compact?: boolean;
  readonly close?: () => void;
  readonly toggleRef?: Ref<HTMLButtonElement>;
};

export function GlyphChatHistory({
  compact,
  close,
  toggleRef,
  archived,
  archivedOpen,
  toggleArchived,
  archive,
  pin,
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
  const chatRow = (chat: GlyphChatHistoryState['archived'][number]) => (
    <div key={chat.id} class={styles.row} data-selected={chat.selected || undefined}>
      <Button
        appearance={ButtonAppearance.BORDERLESS_GHOST}
        class={styles.item}
        type="button"
        aria-current={chat.selected ? 'true' : undefined}
        aria-label={chat.title}
        title={chat.title}
        disabled={navigationPending}
        onClick={() => {
          openChat(chat.id);
        }}
      >
        <span class={styles.activity} aria-label={chat.active ? 'Running' : undefined}>
          {chat.active ? '◌' : '○'}
        </span>
        {chat.title}
      </Button>
      <div class="chat-row-actions">
        {!chat.archived && (
          <IconButton
            appearance={ButtonAppearance.BORDERLESS_GHOST}
            size={ButtonSize.SMALL}
            iconSize={14}
            type="button"
            aria-label={`${chat.pinned ? 'Unpin' : 'Pin'} ${chat.title}`}
            title={chat.pinned ? 'Unpin chat' : 'Pin chat'}
            onClick={() => pin(chat.id, !chat.pinned)}
          >
            {chat.pinned ? <PinOff size={14} /> : <Pin size={14} />}
          </IconButton>
        )}
        <IconButton
          appearance={ButtonAppearance.BORDERLESS_GHOST}
          size={ButtonSize.SMALL}
          iconSize={14}
          type="button"
          disabled={newChatDisabled}
          aria-label={`${chat.archived ? 'Unarchive' : 'Archive'} ${chat.title}`}
          title={chat.archived ? 'Unarchive chat' : 'Archive chat'}
          onClick={() => {
            archive(chat.id, !chat.archived);
          }}
        >
          {chat.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        </IconButton>
      </div>
    </div>
  );
  return (
    <aside
      id="glyph-chat-history"
      class={`glyph-chat-history ${styles.root} ${compact === true ? styles.compact : ''}`}
      aria-label="Chat history"
    >
      {compact !== true && close && (
        <div class={styles.toolbar}>
          <IconButton
            appearance={ButtonAppearance.BORDERLESS_GHOST}
            iconSize={18}
            {...(toggleRef ? { buttonRef: toggleRef } : {})}
            type="button"
            aria-label="Chat history"
            title="Close sidebar"
            aria-expanded={true}
            onClick={close}
          >
            <GlyphSidebarIcon />
          </IconButton>
        </div>
      )}
      <div class={styles.top}>
        <input
          ref={search}
          class={styles.search}
          type="search"
          aria-label="Search chats"
          placeholder="Search chats…"
          value={query}
          onInput={event => {
            setQuery(event.currentTarget.value);
          }}
        />
        {compact !== true && (
          <Button
            appearance={ButtonAppearance.GHOST}
            class={styles.newChatLayout}
            type="button"
            disabled={newChatDisabled}
            onClick={newChat}
          >
            ＋ New chat
          </Button>
        )}
      </div>
      <nav class={styles.list} aria-label="Saved chats" aria-busy={navigationPending}>
        {groups.map(
          group =>
            group.chats.length > 0 && (
              <section key={group.label} aria-label={group.label}>
                <h3 class={styles.group}>{group.label}</h3>
                {group.chats.map(chatRow)}
              </section>
            ),
        )}
        <Button
          appearance={ButtonAppearance.BORDERLESS_GHOST}
          class={styles.newChatLayout}
          type="button"
          aria-expanded={archivedOpen}
          onClick={toggleArchived}
          leadingIcon={archivedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        >
          Archived{archived.length > 0 ? ` (${archived.length})` : ''}
        </Button>
        {archivedOpen && (
          <section aria-label="Archived chats">
            {archived.length > 0 ? (
              archived.map(value => chatRow(value))
            ) : (
              <p class={styles.empty}>No archived chats.</p>
            )}
          </section>
        )}
        {emptyMessage !== undefined && emptyMessage !== '' && <p class={styles.empty}>{emptyMessage}</p>}
      </nav>
      {compact !== true && accountControl}
    </aside>
  );
}
