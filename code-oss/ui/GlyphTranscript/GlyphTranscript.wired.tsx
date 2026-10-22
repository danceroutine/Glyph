import type { GlyphProposalSummary } from '#src/desktop/protocol/events/GlyphProposalSummary.js';
import { GlyphFileChanges } from '#code-oss/ui/GlyphFileChanges/GlyphFileChanges.tsx';
import type { ComponentChildren } from 'preact';
import type { GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import {
  GlyphAgentMessageWithState,
  type GlyphMessageActions,
} from '#code-oss/ui/GlyphAgentMessage/GlyphAgentMessage.wired.tsx';
import { WiredGlyphTranscriptContent } from './GlyphTranscriptContent.wired.tsx';
import { GlyphTranscript, GlyphTranscriptMessage } from './GlyphTranscript.presentational.tsx';
import { useGlyphTranscriptState, type GlyphTranscriptStateOptions } from './useGlyphTranscriptState.ts';
import { GlyphTranscriptRole } from '#src/desktop/workbench/GlyphTranscriptEntry.js';

export interface WiredGlyphTranscriptProps extends GlyphTranscriptStateOptions {
  readonly proposals?: readonly GlyphProposalSummary[];
  readonly plans?: ComponentChildren;
  readonly chatId?: string;
  readonly pendingApproval?: GlyphRunProjection;
  readonly actions?: GlyphMessageActions;
  readonly readOnly?: boolean;
}

export function WiredGlyphTranscript({
  entries,
  plans,
  proposals = [],
  chatId,
  pendingApproval,
  actions,
  readOnly = false,
}: WiredGlyphTranscriptProps) {
  const state = useGlyphTranscriptState({
    entries,
    context: actions?.context,
    openLink: actions?.openLink,
    copyText: actions?.copyText,
    branch:
      !readOnly && chatId !== undefined && chatId !== '' && actions?.branchChat
        ? turnId => actions.branchChat!(chatId, turnId)
        : undefined,
    restore:
      !readOnly && chatId !== undefined && chatId !== '' && actions?.restoreCheckpoint
        ? turnId => actions.restoreCheckpoint!(chatId, turnId)
        : undefined,
  });
  return (
    <GlyphTranscript transcript={state.transcript} plans={plans}>
      {state.entries.map(entry =>
        entry.role === GlyphTranscriptRole.ASSISTANT ? (
          <GlyphAgentMessageWithState
            key={entry.id}
            entry={entry}
            changes={proposals
              .filter(
                proposal =>
                  proposal.chatId === chatId &&
                  entry.progress?.tools.some(tool => tool.summary?.includes(proposal.id) === true) === true,
              )
              .map(proposal => (
                <GlyphFileChanges
                  key={proposal.id}
                  files={proposal.files}
                  review={fileId => {
                    if (chatId !== undefined && chatId !== '')
                      void actions?.reviewProposalFile?.(chatId, proposal.id, fileId);
                  }}
                />
              ))}
            chatId={chatId}
            pendingApproval={pendingApproval}
            actions={actions}
            readOnly={readOnly}
          />
        ) : (
          <GlyphTranscriptMessage
            key={entry.id}
            entry={entry}
            content={<WiredGlyphTranscriptContent entry={entry} />}
          />
        ),
      )}
    </GlyphTranscript>
  );
}
