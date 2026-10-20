import type { GlyphGoal } from '#src/desktop/protocol/events/GlyphGoal.js';
import { GlyphRunStatus, type GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';

export interface GlyphGoalReconciliationSnapshot {
  readonly goal?: GlyphGoal;
  readonly runs: readonly Pick<GlyphRunProjection, 'runId' | 'status'>[];
  readonly connected: boolean;
  readonly ownsWorkspace: boolean;
  readonly submitting: boolean;
  readonly queuedMessages: number;
}

export interface GlyphGoalReconcilerHost {
  snapshot(chatId: string): GlyphGoalReconciliationSnapshot | undefined;
  continueGoal(chatId: string, goalId: string): Promise<void>;
  onError(error: unknown): void;
}

export function goalContinuationKey(snapshot: GlyphGoalReconciliationSnapshot): string | undefined {
  const { goal, runs } = snapshot;
  if (
    goal?.status !== 'active' ||
    !snapshot.connected ||
    !snapshot.ownsWorkspace ||
    snapshot.submitting ||
    snapshot.queuedMessages > 0
  )
    return undefined;
  const last = runs.at(-1);
  if (last && last.status !== GlyphRunStatus.COMPLETED) return undefined;
  return [goal.id, goal.continuationCount, goal.activeSince ?? '', last?.runId ?? ''].join('\0');
}

export class GlyphGoalReconciler {
  private readonly inFlight = new Set<string>();
  private readonly requested = new Set<string>();
  private readonly attempted = new Map<string, string>();

  constructor(private readonly host: GlyphGoalReconcilerHost) {}

  reconcile(chatId: string): void {
    if (this.inFlight.has(chatId)) {
      this.requested.add(chatId);
      return;
    }
    const snapshot = this.host.snapshot(chatId);
    const key = snapshot && goalContinuationKey(snapshot);
    if (!key || this.attempted.get(chatId) === key) return;
    this.attempted.set(chatId, key);
    this.inFlight.add(chatId);
    void this.host
      .continueGoal(chatId, snapshot.goal!.id)
      .catch(error => this.host.onError(error))
      .finally(() => {
        this.inFlight.delete(chatId);
        if (this.requested.delete(chatId)) this.reconcile(chatId);
      });
  }

  reset(): void {
    this.attempted.clear();
  }
}
