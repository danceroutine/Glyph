import { useEffect, useRef, useState } from 'preact/hooks';
import type { GlyphGoal } from '#src/desktop/protocol/events/GlyphGoal.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';

const PAUSE_REASON_LABELS = {
  user: 'Paused · Stopped',
  failed: 'Paused · Run failed',
  stalled: 'Paused · No progress',
} as const satisfies Record<NonNullable<GlyphGoal['pauseReason']>, string>;

export interface GlyphGoalRowStateOptions {
  readonly chatId: string;
  readonly goal: GlyphGoal;
  readonly readOnly: boolean;
  readonly actions: Pick<GlyphWorkbenchViewActions, 'pauseGoal' | 'resumeGoal' | 'clearGoal'>;
  readonly now?: () => number;
}

export type GlyphGoalRowState = ReturnType<typeof useGlyphGoalRowState>;

export function formatGoalDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function useGlyphGoalRowState({ chatId, goal, readOnly, actions, now = Date.now }: GlyphGoalRowStateOptions) {
  const [time, setTime] = useState(now);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const active = goal.status === 'active';
  useEffect(() => {
    setTime(now());
    if (!active) return;
    const timer = setInterval(() => {
      setTime(now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [active, goal.activeSince, now]);
  const perform = async (operation: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const elapsed = goal.activeDurationMs + (goal.activeSince ? Math.max(0, time - Date.parse(goal.activeSince)) : 0);
  return {
    objective: goal.objective,
    status: goal.status,
    statusLabel:
      goal.status === 'paused'
        ? PAUSE_REASON_LABELS[goal.pauseReason ?? 'user']
        : goal.status === 'complete'
          ? 'Complete'
          : 'Active',
    elapsed: formatGoalDuration(elapsed),
    pending,
    error,
    disabled: readOnly || pending,
    canToggle: goal.status !== 'complete',
    toggleLabel: active ? 'Pause goal' : 'Resume goal',
    toggle: () => {
      void perform(() => (active ? actions.pauseGoal(chatId, goal.id) : actions.resumeGoal(chatId, goal.id)));
    },
    clear: () => {
      void perform(() => actions.clearGoal(chatId, goal.id));
    },
  };
}
