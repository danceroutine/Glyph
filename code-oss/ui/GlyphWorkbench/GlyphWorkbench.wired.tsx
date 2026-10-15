import { GlyphWorkbench } from './GlyphWorkbench.presentational.tsx';
import { WiredGlyphQuestionCard } from '#code-oss/ui/GlyphQuestionCard/GlyphQuestionCard.wired.tsx';
import { WiredGlyphComposer } from '#code-oss/ui/GlyphComposer/GlyphComposer.wired.tsx';
import { WiredGlyphTranscript } from '#code-oss/ui/GlyphTranscript/GlyphTranscript.wired.tsx';
import { GlyphUsageSummary } from '#code-oss/ui/GlyphUsageSummary/GlyphUsageSummary.presentational.tsx';
import { WiredGlyphChatHistory } from '#code-oss/ui/GlyphChatHistory/GlyphChatHistory.wired.tsx';
import { WiredGlyphModelPicker } from '#code-oss/ui/GlyphModelPicker/GlyphModelPicker.wired.tsx';
import { useGlyphWorkbenchState, type GlyphWorkbenchStateOptions } from './useGlyphWorkbenchState.ts';

export type WiredGlyphWorkbenchProps = GlyphWorkbenchStateOptions;

export function WiredGlyphWorkbench({ state, actions }: WiredGlyphWorkbenchProps) {
  const { questionRun, approvalRun, initialAnswers, onDraftChange, openedChat, ...view } = useGlyphWorkbenchState({
    state,
    actions,
  });
  return (
    <GlyphWorkbench
      {...view}
      transcript={
        <WiredGlyphTranscript
          entries={state.transcript}
          {...(state.selectedChatId ? { chatId: state.selectedChatId } : {})}
          actions={actions}
          readOnly={state.readOnly}
          {...(approvalRun ? { pendingApproval: approvalRun } : {})}
        />
      }
      usage={state.selectedChatId && <GlyphUsageSummary usage={state.usage[state.selectedChatId]} />}
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
          selection={state.selection}
          actions={actions}
          disabled={!!state.navigationPending || (!state.selectedChatId && !!state.catalogPending)}
          modelControl={<WiredGlyphModelPicker state={state} actions={actions} />}
        />
      }
      history={view.historyOpen && <WiredGlyphChatHistory state={state} actions={actions} onOpened={openedChat} />}
    />
  );
}
