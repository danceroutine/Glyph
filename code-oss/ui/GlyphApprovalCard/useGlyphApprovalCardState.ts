import type { GlyphApprovalRequest } from '#src/desktop/protocol/events/GlyphApprovalRequest.js';
import { GlyphApprovalDecision } from '#src/desktop/protocol/GlyphApprovalDecision.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { useGlyphDecision } from '#code-oss/ui/useGlyphDecision.ts';

export interface GlyphApprovalCardStateOptions {
  readonly request: GlyphApprovalRequest;
  readonly chatId: string;
  readonly runId: string;
  readonly actions: Pick<GlyphWorkbenchViewActions, 'decideApproval'>;
  readonly disabled: boolean;
}

export type GlyphApprovalCardState = ReturnType<typeof useGlyphApprovalCardState>;

export function useGlyphApprovalCardState({
  request,
  chatId,
  runId,
  actions,
  disabled,
}: GlyphApprovalCardStateOptions) {
  const { pending, error, submit } = useGlyphDecision();
  const decide = (decision: GlyphApprovalDecision) => {
    if (!disabled) void submit(() => actions.decideApproval(chatId, runId, request.id, decision));
  };
  return {
    request,
    disabled,
    pending,
    error,
    skip: () => decide(GlyphApprovalDecision.DENY),
    alwaysRun: () => decide(GlyphApprovalDecision.ALWAYS_ALLOW),
    run: () => decide(GlyphApprovalDecision.ALLOW_ONCE),
  };
}
