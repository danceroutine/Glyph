import type { GoalPauseReason } from './GoalPauseReason.ts';
import type { GoalStatus } from './GoalStatus.ts';

export interface ChatGoal {
  readonly id: string;
  readonly objective: string;
  readonly status: GoalStatus;
  readonly pauseReason?: GoalPauseReason;
  readonly createdAt: string;
  readonly continuationCount: number;
  readonly idleContinuationsWithoutToolCalls: number;
  readonly activeDurationMs: number;
  readonly activeSince?: string;
}
