import { WiredGlyphPlanCards } from '#code-oss/ui/GlyphPlan/GlyphPlanCards.wired.tsx';
import { WiredGlyphAnnotations } from '#code-oss/ui/GlyphAnnotations/GlyphAnnotations.wired.tsx';
import { WiredGlyphPendingReviews } from '#code-oss/ui/GlyphPendingReviews/GlyphPendingReviews.wired.tsx';
import { WiredGlyphProposalPreviews } from '#code-oss/ui/GlyphProposalPreview/GlyphProposalPreview.wired.tsx';
import { GlyphWorkbench } from './GlyphWorkbench.presentational.tsx';
import { WiredGlyphTodoCard } from '#code-oss/ui/GlyphTodoCard/GlyphTodoCard.wired.tsx';
import { WiredGlyphQuestionCard } from '#code-oss/ui/GlyphQuestionCard/GlyphQuestionCard.wired.tsx';
import { WiredGlyphComposer } from '#code-oss/ui/GlyphComposer/GlyphComposer.wired.tsx';
import { WiredGlyphTranscript } from '#code-oss/ui/GlyphTranscript/GlyphTranscript.wired.tsx';
import { WiredGlyphUsageSummary as GlyphUsageSummary } from '#code-oss/ui/GlyphUsageSummary/GlyphUsageSummary.wired.tsx';
import { WiredGlyphChatHistory } from '#code-oss/ui/GlyphChatHistory/GlyphChatHistory.wired.tsx';
import { WiredGlyphModelPicker } from '#code-oss/ui/GlyphModelPicker/GlyphModelPicker.wired.tsx';
import { useGlyphWorkbenchState, type GlyphWorkbenchStateOptions } from './useGlyphWorkbenchState.ts';

export type WiredGlyphWorkbenchProps = GlyphWorkbenchStateOptions;

export function WiredGlyphWorkbench({ state, actions }: WiredGlyphWorkbenchProps) {
  const {
    questionRun,
    approvalRun,
    initialAnswers,
    onDraftChange,
    openedChat,
    todos,
    proposals,
    plans,
    plansDisabled,
    ...view
  } = useGlyphWorkbenchState({
    state,
    actions,
  });
  return (
    <>
      <WiredGlyphAnnotations
        key={state.selectedChatId ?? 'draft'}
        composer={actions.composer}
        disabled={state.readOnly}
      />
      <GlyphWorkbench
        {...view}
        transcript={
          <WiredGlyphTranscript
            proposals={
              state.selectedChatId && (
                <>
                  <WiredGlyphPlanCards
                    chatId={state.selectedChatId}
                    plans={plans}
                    actions={actions}
                    disabled={plansDisabled}
                  />
                  <WiredGlyphProposalPreviews
                    key={state.selectedChatId}
                    chatId={state.selectedChatId}
                    proposals={proposals}
                    readOnly={state.readOnly}
                    actions={actions}
                  />
                </>
              )
            }
            entries={state.transcript}
            {...(state.selectedChatId ? { chatId: state.selectedChatId } : {})}
            actions={actions}
            readOnly={state.readOnly}
            {...(approvalRun ? { pendingApproval: approvalRun } : {})}
          />
        }
        usage={state.selectedChatId && <GlyphUsageSummary usage={state.usage[state.selectedChatId]} />}
        reviews={
          state.selectedChatId &&
          proposals.length > 0 && (
            <WiredGlyphPendingReviews
              key={state.selectedChatId}
              chatId={state.selectedChatId}
              proposals={proposals}
              readOnly={state.readOnly}
              actions={actions}
            />
          )
        }
        todos={todos.length > 0 && <WiredGlyphTodoCard key={state.selectedChatId} items={todos} />}
        question={
          questionRun?.question && (
            <WiredGlyphQuestionCard
              key={questionRun.question.id}
              request={questionRun.question}
              chatId={questionRun.chatId}
              runId={questionRun.runId}
              actions={actions}
              disabled={state.readOnly}
              initialAnswers={initialAnswers}
              onDraftChange={onDraftChange}
            />
          )
        }
        composer={
          <WiredGlyphComposer
            status={state.status}
            key={state.selectedChatId ?? 'draft'}
            actions={actions}
            disabled={state.readOnly || !!state.navigationPending || (!state.selectedChatId && !!state.catalogPending)}
            modelControl={<WiredGlyphModelPicker state={state} actions={actions} />}
          />
        }
        history={view.historyOpen && <WiredGlyphChatHistory state={state} actions={actions} onOpened={openedChat} />}
      />
    </>
  );
}
