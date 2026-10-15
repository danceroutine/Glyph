import type { GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { GlyphApprovalCard } from './GlyphApprovalCard.tsx';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { GlyphTranscriptRole, type GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import { GlyphTurnProgress } from './GlyphTurnProgress.tsx';
import { css, tokens } from './design-system/index.ts';

const styles = {
  root: css({ flex: 1, minHeight: 0, overflowY: 'auto', padding: tokens.space.lg }),
  entry: css({ marginBottom: tokens.space.lg, whiteSpace: 'pre-wrap', userSelect: 'text' }),
};

interface GlyphTranscriptProps {
  readonly entries: readonly GlyphTranscriptEntry[];
  readonly pendingApproval?: GlyphRunProjection;
  readonly actions?: Pick<GlyphWorkbenchViewActions, 'decideApproval'>;
  readonly readOnly?: boolean;
}

/** Stable turn keys preserve DOM identity instead of recreating the transcript on each delta. */
export function GlyphTranscript({ entries, pendingApproval, actions, readOnly = false }: GlyphTranscriptProps) {
  const transcript = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = transcript.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries]);
  return (
    <div class={`glyph-transcript ${styles.root}`} ref={transcript} role="log" aria-label="Glyph conversation">
      {entries.map(entry => (
        <div class={`glyph-entry ${entry.role} ${styles.entry}`} key={entry.id}>
          <strong>{roleLabel(entry.role)}</strong>
          {entry.progress && <GlyphTurnProgress progress={entry.progress} />}
          <div>{entry.text}</div>
          {pendingApproval?.runId === entry.id && pendingApproval.approval && actions && (
            <GlyphApprovalCard
              key={pendingApproval.approval.id}
              request={pendingApproval.approval}
              chatId={pendingApproval.chatId}
              runId={pendingApproval.runId}
              actions={actions}
              disabled={readOnly}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function roleLabel(role: GlyphTranscriptRole): string {
  switch (role) {
    case GlyphTranscriptRole.USER:
      return 'You';
    case GlyphTranscriptRole.ASSISTANT:
      return 'Glyph';
    case GlyphTranscriptRole.DIAGNOSTIC:
      return 'Status';
  }
}
