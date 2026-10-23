import { GlyphModeSwapStatus } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import type { GlyphModeSwap } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { GlyphApprovalDecision } from '#src/desktop/protocol/GlyphApprovalDecision.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { useEffect, useState } from 'preact/hooks';
import { useGlyphDecision } from '#code-oss/ui/useGlyphDecision.ts';
import { GlyphModeSwapCard } from './GlyphModeSwapCard.presentational.tsx';

export function WiredGlyphModeSwapCard({
  swap,
  chatId,
  runId,
  actions,
  disabled,
}: {
  readonly swap: GlyphModeSwap;
  readonly chatId: string;
  readonly runId: string;
  readonly actions: Pick<GlyphWorkbenchViewActions, 'decideApproval'>;
  readonly disabled: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  const { pending, error, submit } = useGlyphDecision();
  useEffect(() => {
    if (swap.status !== GlyphModeSwapStatus.PENDING) return undefined;
    setNow(Date.now());
    let frame: number;
    const tick = () => {
      setNow(Date.now());
      if (Date.now() < Date.parse(swap.expiresAt)) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [swap.id, swap.status, swap.expiresAt]);
  const decide = (decision: GlyphApprovalDecision) => {
    if (!disabled && swap.status === GlyphModeSwapStatus.PENDING)
      void submit(() => actions.decideApproval(chatId, runId, swap.id, decision));
  };
  const deadline = Date.parse(swap.expiresAt);
  const duration = deadline - Date.parse(swap.startedAt ?? swap.expiresAt);
  const remaining = duration > 0 ? Math.max(0, Math.min(1, (deadline - now) / duration)) : 0;
  // The host owns expiry; this clock only displays its absolute deadline.
  return (
    <GlyphModeSwapCard
      swap={swap}
      remaining={remaining}
      seconds={Math.max(0, Math.ceil((Date.parse(swap.expiresAt) - now) / 1000))}
      disabled={disabled}
      pending={pending}
      error={error}
      approve={() => {
        decide(GlyphApprovalDecision.ALLOW_ONCE);
      }}
      deny={() => {
        decide(GlyphApprovalDecision.DENY);
      }}
    />
  );
}
