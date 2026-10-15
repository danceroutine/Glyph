import type { GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';

export interface GlyphChatHistoryStateOptions {
  readonly state: GlyphWorkbenchState;
  readonly actions: GlyphWorkbenchViewActions;
  readonly onOpened: () => void;
}

export type GlyphChatHistoryState = ReturnType<typeof useGlyphChatHistoryState>;

export function useGlyphChatHistoryState({ state, actions, onOpened }: GlyphChatHistoryStateOptions) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => search.current?.focus(), []);
  const chats = [...state.chats]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .filter(chat => chat.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .map(chat => ({
      id: chat.id,
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
  return {
    query,
    setQuery,
    search,
    groups,
    emptyMessage: chats.length ? undefined : query ? 'No matching chats.' : 'Your conversations will appear here.',
    newChatDisabled: state.navigationPending || state.readOnly,
    navigationPending: !!state.navigationPending,
    newChat: () => {
      actions.newChat();
      onOpened();
    },
    openChat: (id: string) => {
      void actions.openChat(id).then(onOpened);
    },
  };
}
