import type { ComponentChildren } from 'preact';
import { GlyphAgentMessage } from './GlyphAgentMessage.presentational.tsx';
import { useGlyphMessageState, type GlyphMessageState } from './useGlyphMessageState.ts';
import { WiredGlyphTranscriptContent } from '#code-oss/ui/GlyphTranscript/GlyphTranscriptContent.wired.tsx';
import { WiredGlyphUsageSummary } from '#code-oss/ui/GlyphUsageSummary/GlyphUsageSummary.wired.tsx';
import { WiredGlyphShellCommandCard } from '#code-oss/ui/GlyphShellCommandCard/GlyphShellCommandCard.wired.tsx';
import { WiredGlyphModeSwapCard } from '#code-oss/ui/GlyphModeSwapCard/GlyphModeSwapCard.wired.tsx';
import { WiredGlyphApprovalCard } from '#code-oss/ui/GlyphApprovalCard/GlyphApprovalCard.wired.tsx';
import type { GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import type { GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';

export type GlyphMessageActions = Pick<GlyphWorkbenchViewActions, 'decideApproval' | 'writeShellInput' | 'stopShell'> &
  Partial<
    Pick<
      GlyphWorkbenchViewActions,
      'context' | 'openLink' | 'branchChat' | 'restoreCheckpoint' | 'copyText' | 'reviewProposalFile'
    >
  >;

export interface WiredGlyphAgentMessageProps {
  readonly entry: GlyphTranscriptEntry;
  readonly chatId?: string;
  readonly pendingApproval?: GlyphRunProjection;
  readonly actions?: GlyphMessageActions;
  readonly readOnly?: boolean;
}

/** Standalone entry point; transcripts supply their shared message-action state below. */
export function WiredGlyphAgentMessage({
  entry,
  actions,
  chatId,
  readOnly = false,
  ...props
}: WiredGlyphAgentMessageProps) {
  const state = useGlyphMessageState({
    entries: [entry],
    context: actions?.context,
    openLink: actions?.openLink,
    copyText: actions?.copyText,
    branch: !readOnly && chatId && actions?.branchChat ? turnId => actions.branchChat!(chatId, turnId) : undefined,
  });
  return (
    <GlyphAgentMessageWithState
      {...props}
      entry={state.entries[0]!}
      actions={actions}
      chatId={chatId}
      readOnly={readOnly}
    />
  );
}

export interface GlyphAgentMessageWithStateProps {
  readonly changes?: ComponentChildren;
  readonly entry: GlyphMessageState['entries'][number];
  readonly chatId?: string | undefined;
  readonly pendingApproval?: GlyphRunProjection | undefined;
  readonly actions?: GlyphMessageActions | undefined;
  readonly readOnly?: boolean;
}

/** Uses the transcript's shared history lock when rendered in a conversation. */
export function GlyphAgentMessageWithState({
  entry,
  chatId,
  pendingApproval,
  changes,
  actions,
  readOnly = false,
}: GlyphAgentMessageWithStateProps) {
  return (
    <GlyphAgentMessage
      entry={entry}
      changes={changes}
      content={<WiredGlyphTranscriptContent entry={entry} />}
      usage={<WiredGlyphUsageSummary usage={entry.usage} turn />}
      shells={
        actions && chatId
          ? entry.shellActivities.map(tool => (
              <WiredGlyphShellCommandCard
                key={tool.id}
                activity={tool}
                chatId={chatId}
                readOnly={readOnly}
                actions={actions}
              />
            ))
          : undefined
      }
      modeSwapCards={
        actions && chatId
          ? entry.modeSwaps?.map(swap => (
              <WiredGlyphModeSwapCard
                key={swap.id}
                swap={swap}
                chatId={chatId}
                runId={entry.id}
                actions={actions}
                disabled={readOnly}
              />
            ))
          : undefined
      }
      approval={
        pendingApproval?.runId === entry.id &&
        pendingApproval.approval &&
        !pendingApproval.approval.modeSwap &&
        actions ? (
          <WiredGlyphApprovalCard
            key={pendingApproval.approval.id}
            request={pendingApproval.approval}
            chatId={pendingApproval.chatId}
            runId={pendingApproval.runId}
            actions={actions}
            disabled={readOnly}
          />
        ) : undefined
      }
    />
  );
}
