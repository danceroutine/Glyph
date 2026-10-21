import type { GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { GlyphRunStatus, type GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import type { GlyphChatSummary } from '#src/desktop/protocol/events/GlyphChatSummary.js';

export enum GlyphChatActivity {
  WORKING = 'working',
  AWAITING_INPUT = 'awaiting_input',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  INTERRUPTED = 'interrupted',
  FAILED = 'failed',
  EMPTY = 'empty',
  DRAFT = 'draft',
}

const GLYPH_RUN_STATUS_TO_GLYPH_CHAT_ACTIVITY: Record<GlyphRunStatus, GlyphChatActivity> = {
  [GlyphRunStatus.STREAMING]: GlyphChatActivity.WORKING,
  [GlyphRunStatus.WAITING_FOR_QUESTION]: GlyphChatActivity.AWAITING_INPUT,
  [GlyphRunStatus.WAITING_FOR_APPROVAL]: GlyphChatActivity.AWAITING_INPUT,
  [GlyphRunStatus.COMPLETED]: GlyphChatActivity.COMPLETED,
  [GlyphRunStatus.CANCELLED]: GlyphChatActivity.CANCELLED,
  [GlyphRunStatus.INTERRUPTED]: GlyphChatActivity.INTERRUPTED,
  [GlyphRunStatus.FAILED]: GlyphChatActivity.FAILED,
};

const ACTIVE_RUN_STATUSES = [
  GlyphRunStatus.STREAMING,
  GlyphRunStatus.WAITING_FOR_QUESTION,
  GlyphRunStatus.WAITING_FOR_APPROVAL,
];

function toChatActivity(chat: GlyphChatSummary, runs: readonly GlyphRunProjection[]): GlyphChatActivity {
  const chatRuns = runs.filter(run => run.chatId === chat.id);
  const run = chatRuns.find(value => ACTIVE_RUN_STATUSES.includes(value.status)) ?? chatRuns.at(-1);
  if (run) return GLYPH_RUN_STATUS_TO_GLYPH_CHAT_ACTIVITY[run.status];
  return chat.turnCount > 0 ? GlyphChatActivity.COMPLETED : GlyphChatActivity.EMPTY;
}

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
  const matches = (title: string) => title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const allChats = [...state.chats]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .filter(chat => matches(chat.title))
    .map(chat => ({
      id: chat.id,
      archived: state.archivedChatIds?.includes(chat.id) ?? false,
      pinned: state.pinnedChatIds?.includes(chat.id) ?? false,
      draft: false,
      title: chat.title,
      updatedAt: chat.updatedAt,
      selected: state.selectedChatId === chat.id,
      activity: toChatActivity(chat, state.runs),
    }));
  const draft = state.newChatDraft;
  const draftTitle = draft && `Draft: ${draft.text.trim().split('\n')[0]?.trim()}`;
  const drafts =
    draft && draftTitle && matches(draftTitle)
      ? [
          {
            id: '',
            archived: false,
            pinned: false,
            draft: true,
            title: draftTitle,
            updatedAt: draft.createdAt,
            selected: state.selectedChatId === undefined,
            activity: GlyphChatActivity.DRAFT,
          },
        ]
      : [];
  const chats = allChats.filter(chat => !chat.archived);
  const unpinned = [...drafts, ...chats.filter(chat => !chat.pinned)];
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
    toggleArchived: () => setArchivedOpen(!archivedOpen),
    archived: allChats.filter(chat => chat.archived),
    archive: (id: string, archived: boolean) => void actions.setChatArchived?.(id, archived),
    pin: (id: string, pinned: boolean) => actions.setChatPinned?.(id, pinned),
    query,
    setQuery,
    search,
    groups,
    emptyMessage:
      chats.length || drafts.length ? undefined : query ? 'No matching chats.' : 'Your conversations will appear here.',
    newChatDisabled: state.navigationPending || state.readOnly,
    navigationPending: !!state.navigationPending,
    newChat: () => {
      actions.newChat();
    },
    openChat: (id: string) => (id ? void actions.openChat(id) : actions.newChat()),
  };
}
