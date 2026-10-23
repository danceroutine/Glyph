import type { GlyphWorkbenchState as HostWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import type { QuestionAnswer } from '#src/interaction/questions/QuestionAnswer.js';
import { tokens } from '#code-oss/ui/design-system/index.ts';

export interface GlyphWorkbenchStateOptions {
  readonly state: HostWorkbenchState;
  readonly actions: GlyphWorkbenchViewActions;
}

export type GlyphWorkbenchState = ReturnType<typeof useGlyphWorkbenchState>;

/** Keeps pane state and question drafts separate from authoritative host updates. */
export function useGlyphWorkbenchState({ state, actions }: GlyphWorkbenchStateOptions) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (historyOpen) return actions.reserveHistoryWidth?.(tokens.history.columnWidth);
    return undefined;
  }, [historyOpen, actions.reserveHistoryWidth]);
  const toggle = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (wasOpen.current && !historyOpen) toggle.current?.focus();
    wasOpen.current = historyOpen;
  }, [historyOpen]);
  const chat = state.chats.find(value => value.id === state.selectedChatId);
  const questionRun = state.runs.find(
    run => run.chatId === state.selectedChatId && run.status === GlyphRunStatus.WAITING_FOR_QUESTION,
  );
  const approvalRun = state.runs.find(
    run => run.chatId === state.selectedChatId && run.status === GlyphRunStatus.WAITING_FOR_APPROVAL,
  );
  const questionDrafts = useRef(new Map<string, readonly QuestionAnswer[]>());
  useEffect(() => {
    const pending = new Set(
      state.runs.filter(run => run.status === GlyphRunStatus.WAITING_FOR_QUESTION).map(run => run.question?.id),
    );
    for (const id of questionDrafts.current.keys()) if (!pending.has(id)) questionDrafts.current.delete(id);
  }, [state.runs]);
  const closeHistory = () => {
    setHistoryOpen(false);
    toggle.current?.focus();
  };
  return {
    root,
    toggle,
    historyOpen,
    tabs: (state.openChatIds ?? [state.selectedChatId ?? '']).map(id => ({
      id,
      title: state.chats.find(candidate => candidate.id === id)?.title ?? 'New chat',
      selected: id === (state.selectedChatId ?? ''),
    })),
    selectTab: (id: string) => {
      if (id === '') actions.newChat();
      else void actions.openChat(id);
    },
    closeTab: (id: string) => void actions.closeChat?.(id),
    todos: chat?.todos ?? [],
    plans: chat?.plans ?? [],
    plansDisabled:
      state.readOnly ||
      state.runs.some(
        run =>
          run.chatId === state.selectedChatId &&
          [GlyphRunStatus.STREAMING, GlyphRunStatus.WAITING_FOR_QUESTION, GlyphRunStatus.WAITING_FOR_APPROVAL].includes(
            run.status,
          ),
      ),
    proposals: state.proposals.filter(
      proposal =>
        proposal.chatId === state.selectedChatId && proposal.files.some(file => file.pendingItemIds.length > 0),
    ),
    newChatDisabled: state.navigationPending === true || state.readOnly,
    navigationError: state.navigationError,
    newChat: () => {
      actions.newChat();
    },
    toggleHistory: () => {
      setHistoryOpen(!historyOpen);
    },
    closeHistory,
    questionRun,
    approvalRun,
    initialAnswers: questionRun?.question ? (questionDrafts.current.get(questionRun.question.id) ?? []) : [],
    onDraftChange: (answers: readonly QuestionAnswer[]) => {
      if (questionRun?.question) questionDrafts.current.set(questionRun.question.id, answers);
    },
  };
}
