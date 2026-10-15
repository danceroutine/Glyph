import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import type { QuestionAnswer } from '#src/interaction/questions/QuestionAnswer.js';
import { GlyphQuestionCard } from './GlyphQuestionCard.tsx';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { GlyphComposer } from './GlyphComposer.tsx';
import { GlyphTranscript } from './GlyphTranscript.tsx';
import { GlyphUsageSummary } from './GlyphUsageSummary.tsx';
import { GlyphChatHistory } from './GlyphChatHistory.tsx';
import { GlyphModelPicker } from './GlyphModelPicker.tsx';
import { css, tokens, space } from './design-system/index.ts';

/** Also used by standalone component stories to reproduce the pane layout. */
export const workbenchClassName = css({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  containerType: 'inline-size',
});

interface GlyphWorkbenchProps {
  readonly state: GlyphWorkbenchState;
  readonly actions: GlyphWorkbenchViewActions;
}

const styles = {
  header: css({
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.md,
    padding: space('md', 'lg'),
    borderBottom: tokens.border.default,
  }),
  title: css({
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: tokens.font.weight.semibold,
  }),
  button: css({
    display: 'grid',
    placeItems: 'center',
    padding: tokens.space.xs,
    border: 0,
    borderRadius: tokens.button.radius,
    background: 'transparent',
    color: tokens.text.primary,
    cursor: 'pointer',
    ':hover': { background: tokens.button.quiet.hoverBackground },
    ':focus-visible': { outline: tokens.focus.ring },
  }),
  body: css({ position: 'relative', display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }),
  conversation: css({ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }),
  error: css({ padding: space('md', 'lg'), color: tokens.text.error, overflowWrap: 'anywhere' }),
};

/** Projects host updates without replacing the window-owned composer state. */
export function GlyphWorkbench({ state, actions }: GlyphWorkbenchProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWide(element.clientWidth >= tokens.layout.widePane));
    observer.observe(element);
    setWide(element.clientWidth >= tokens.layout.widePane);
    return () => observer.disconnect();
  }, []);
  const toggle = useRef<HTMLButtonElement>(null);
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
  const openedChat = () => {
    if ((root.current?.clientWidth ?? 0) < tokens.layout.widePane) closeHistory();
  };
  return (
    <div
      ref={root}
      class={`glyph-workbench ${workbenchClassName}`}
      onKeyDown={event => {
        if (event.key === 'Escape' && historyOpen) {
          event.stopPropagation();
          closeHistory();
        }
      }}
    >
      <header class={styles.header}>
        <span class={styles.title}>{chat?.title ?? 'New chat'}</span>
        <button
          class={styles.button}
          type="button"
          aria-label="New chat"
          title="New chat"
          disabled={state.navigationPending || state.readOnly}
          onClick={() => actions.newChat()}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path d="M9 3v12M3 9h12" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </button>
        <button
          ref={toggle}
          class={styles.button}
          type="button"
          aria-label="Chat history"
          title="Chat history"
          aria-expanded={historyOpen}
          aria-controls="glyph-chat-history"
          onClick={() => setHistoryOpen(!historyOpen)}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <rect x="2" y="3" width="14" height="12" rx="1" stroke="currentColor" fill="none" />
            <path d="M11 3v12" stroke="currentColor" />
          </svg>
        </button>
      </header>
      <div class={styles.body}>
        <main class={styles.conversation} aria-label="Current conversation" inert={historyOpen && !wide}>
          <GlyphTranscript
            entries={state.transcript}
            actions={actions}
            readOnly={state.readOnly}
            {...(approvalRun ? { pendingApproval: approvalRun } : {})}
          />
          {state.selectedChatId && <GlyphUsageSummary usage={state.usage[state.selectedChatId]} />}
          {state.navigationError && (
            <div class={styles.error} role="alert">
              {state.navigationError}
            </div>
          )}
          {questionRun?.question && (
            <GlyphQuestionCard
              key={questionRun.question.id}
              request={questionRun.question}
              chatId={questionRun.chatId}
              runId={questionRun.runId}
              actions={actions}
              disabled={state.readOnly}
              initialAnswers={questionDrafts.current.get(questionRun.question.id) ?? []}
              onDraftChange={answers => questionDrafts.current.set(questionRun.question!.id, answers)}
            />
          )}
          <GlyphComposer
            status={state.status}
            selection={state.selection}
            actions={actions}
            disabled={!!state.navigationPending || (!state.selectedChatId && !!state.catalogPending)}
            modelControl={<GlyphModelPicker state={state} actions={actions} />}
          />
        </main>
        {historyOpen && <GlyphChatHistory state={state} actions={actions} onOpened={openedChat} />}
      </div>
    </div>
  );
}
