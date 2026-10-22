import type { GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';

export interface GlyphChatHistoryStateOptions {
  readonly state: GlyphWorkbenchState;
  readonly actions: GlyphWorkbenchViewActions;
}

export type GlyphChatHistoryState = ReturnType<typeof useGlyphChatHistoryState>;

export function useGlyphChatHistoryState({ state, actions }: GlyphChatHistoryStateOptions) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => search.current?.focus(), []);
  const allChats = state.chats
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .filter(chat => chat.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .map(chat => ({
      id: chat.id,
      archived: state.archivedChatIds?.includes(chat.id) ?? false,
      pinned: state.pinnedChatIds?.includes(chat.id) ?? false,
      title: chat.title,
      updatedAt: chat.updatedAt,
      selected: state.selectedChatId === chat.id,
      active: state.runs.some(
        run =>
          run.chatId === chat.id &&
          [GlyphRunStatus.STREAMING, GlyphRunStatus.WAITING_FOR_QUESTION, GlyphRunStatus.WAITING_FOR_APPROVAL].includes(
            run.status,
          ),
      ),
    }));
  const chats = allChats.filter(chat => !chat.archived);
  const unpinned = chats.filter(chat => !chat.pinned);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups = [
    { label: 'Pinned', chats: chats.filter(chat => chat.pinned) },
    { label: 'Today', chats: unpinned.filter(chat => Date.parse(chat.updatedAt) >= today.getTime()) },
    {
      label: 'Yesterday',
      chats: unpinned.filter(
        chat => Date.parse(chat.updatedAt) < today.getTime() && Date.parse(chat.updatedAt) >= yesterday.getTime(),
      ),
    },
    { label: 'Older', chats: unpinned.filter(chat => Date.parse(chat.updatedAt) < yesterday.getTime()) },
  ];
  return {
    archivedOpen,
    toggleArchived: () => {
      setArchivedOpen(!archivedOpen);
    },
    archived: allChats.filter(chat => chat.archived),
    archive: (id: string, archived: boolean) => void actions.setChatArchived?.(id, archived),
    pin: (id: string, pinned: boolean) => actions.setChatPinned?.(id, pinned),
    query,
    setQuery,
    search,
    groups,
    emptyMessage: chats.length > 0 ? undefined : query ? 'No matching chats.' : 'Your conversations will appear here.',
    newChatDisabled: state.navigationPending === true || state.readOnly,
    navigationPending: state.navigationPending === true,
    newChat: () => {
      actions.newChat();
    },
    openChat: (id: string) => {
      void actions.openChat(id);
    },
  };
}
