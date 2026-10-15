import type { GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { GlyphTranscript } from './GlyphTranscript.presentational.tsx';
import { WiredGlyphApprovalCard } from '../GlyphApprovalCard/GlyphApprovalCard.wired.tsx';
import { useGlyphTranscriptState, type GlyphTranscriptStateOptions } from './useGlyphTranscriptState.ts';

export interface WiredGlyphTranscriptProps extends GlyphTranscriptStateOptions {
  readonly pendingApproval?: GlyphRunProjection;
  readonly actions?: Pick<GlyphWorkbenchViewActions, 'decideApproval'>;
  readonly readOnly?: boolean;
}

export function WiredGlyphTranscript({
  entries,
  pendingApproval,
  actions,
  readOnly = false,
}: WiredGlyphTranscriptProps) {
  const state = useGlyphTranscriptState({ entries });
  return (
    <GlyphTranscript
      {...state}
      entries={state.entries.map(entry => ({
        ...entry,
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
