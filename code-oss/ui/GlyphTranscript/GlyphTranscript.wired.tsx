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
  readonly actions?: Pick<GlyphWorkbenchViewActions, 'decideApproval' | 'writeShellInput' | 'stopShell'>;
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
  const state = useGlyphTranscriptState({ entries });
  return (
    <GlyphTranscript
      {...state}
      proposals={proposals}
      entries={state.entries.map(entry => ({
        ...entry,
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
