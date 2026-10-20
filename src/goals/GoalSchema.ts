import { z } from 'zod';
import type { ChatGoal } from './ChatGoal.ts';
import { GoalPauseReason } from './GoalPauseReason.ts';
import { GoalStatus } from './GoalStatus.ts';

export const goalObjectiveSchema = z.string().trim().min(1).max(4000);

export const chatGoalSchema = z
  .object({
    id: z.string().min(1),
    objective: goalObjectiveSchema,
    status: z.enum(GoalStatus),
    pauseReason: z.enum(GoalPauseReason).optional(),
    createdAt: z.iso.datetime(),
    continuationCount: z.number().int().nonnegative(),
    idleContinuationsWithoutToolCalls: z.number().int().nonnegative(),
    activeDurationMs: z.number().int().nonnegative(),
    activeSince: z.iso.datetime().optional(),
  })
  .strict()
  .transform(({ pauseReason, activeSince, ...goal }): ChatGoal => ({
    ...goal,
    ...(pauseReason === undefined ? {} : { pauseReason }),
    ...(activeSince === undefined ? {} : { activeSince }),
  }));
