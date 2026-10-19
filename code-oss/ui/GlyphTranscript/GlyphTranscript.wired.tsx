import { WiredGlyphTranscriptContent } from './GlyphTranscriptContent.wired.tsx';
import { WiredGlyphUsageSummary } from '#code-oss/ui/GlyphUsageSummary/GlyphUsageSummary.wired.tsx';
import type { ComponentChildren } from 'preact';
import { WiredGlyphShellCommandCard } from '#code-oss/ui/GlyphShellCommandCard/GlyphShellCommandCard.wired.tsx';
import type { GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { GlyphTranscript } from './GlyphTranscript.presentational.tsx';
import { WiredGlyphApprovalCard } from '#code-oss/ui/GlyphApprovalCard/GlyphApprovalCard.wired.tsx';
import { useGlyphTranscriptState, type GlyphTranscriptStateOptions } from './useGlyphTranscriptState.ts';

export interface WiredGlyphTranscriptProps extends GlyphTranscriptStateOptions {
  readonly proposals?: ComponentChildren;
  readonly chatId?: string;
  readonly pendingApproval?: GlyphRunProjection;
  readonly actions?: Pick<GlyphWorkbenchViewActions, 'decideApproval' | 'writeShellInput' | 'stopShell'> &
    Partial<Pick<GlyphWorkbenchViewActions, 'context' | 'openLink' | 'branchChat' | 'restoreCheckpoint'>>;
  readonly readOnly?: boolean;
}

export function WiredGlyphTranscript({
  entries,
  proposals,
  chatId,
  pendingApproval,
  actions,
  readOnly = false,
}: WiredGlyphTranscriptProps) {
  const state = useGlyphTranscriptState({
    entries,
    context: actions?.context,
    openLink: actions?.openLink,
    branch: !readOnly && chatId && actions?.branchChat ? turnId => actions.branchChat!(chatId, turnId) : undefined,
    restore:
      !readOnly && chatId && actions?.restoreCheckpoint
        ? turnId => actions.restoreCheckpoint!(chatId, turnId)
        : undefined,
  });
  return (
    <GlyphTranscript
      {...state}
      proposals={proposals}
      entries={state.entries.map(entry => ({
        ...entry,
        content: <WiredGlyphTranscriptContent entry={entry} />,
        usage: entry.role === 'assistant' ? <WiredGlyphUsageSummary usage={entry.usage} turn /> : undefined,
        shells:
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
            : undefined,
        approval:
          pendingApproval?.runId === entry.id && pendingApproval.approval && actions ? (
            <WiredGlyphApprovalCard
              key={pendingApproval.approval.id}
              request={pendingApproval.approval}
              chatId={pendingApproval.chatId}
              runId={pendingApproval.runId}
              actions={actions}
              disabled={readOnly}
            />
          ) : undefined,
      }))}
    />
  );
}
