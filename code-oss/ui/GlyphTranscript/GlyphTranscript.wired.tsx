import type { ComponentChildren } from 'preact';
import type { GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import {
  GlyphAgentMessageWithState,
  type GlyphMessageActions,
} from '#code-oss/ui/GlyphAgentMessage/GlyphAgentMessage.wired.tsx';
import { WiredGlyphTranscriptContent } from './GlyphTranscriptContent.wired.tsx';
import { GlyphTranscript, GlyphTranscriptMessage } from './GlyphTranscript.presentational.tsx';
import { useGlyphTranscriptState, type GlyphTranscriptStateOptions } from './useGlyphTranscriptState.ts';

export interface WiredGlyphTranscriptProps extends GlyphTranscriptStateOptions {
  readonly plans?: ComponentChildren;
  readonly chatId?: string;
  readonly pendingApproval?: GlyphRunProjection;
  readonly actions?: GlyphMessageActions;
  readonly readOnly?: boolean;
}

export function WiredGlyphTranscript({
  entries,
  plans,
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
    branch: !readOnly && chatId && actions?.branchChat ? turnId => actions.branchChat!(chatId, turnId) : undefined,
    restore:
      !readOnly && chatId && actions?.restoreCheckpoint
        ? turnId => actions.restoreCheckpoint!(chatId, turnId)
        : undefined,
  });
  return (
    <GlyphTranscript transcript={state.transcript} plans={plans}>
      {state.entries.map(entry =>
        entry.role === 'assistant' ? (
          <GlyphAgentMessageWithState
            key={entry.id}
            entry={entry}
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
