import { describe, expect, it } from 'vitest';
import { Goal } from '#src/goals/Goal.js';
import { GoalError } from '#src/goals/GoalError.js';
import { GoalPauseReason } from '#src/goals/GoalPauseReason.js';
import { GoalStatus } from '#src/goals/GoalStatus.js';

describe(Goal, () => {
  describe(Goal.create, () => {
    it('arms an active goal with the trimmed objective and a running clock', () => {
      const now = new Date('2026-10-20T14:00:00.000Z');

      expect(Goal.create('goal', '  Ship the feature  ', now).toChatGoal()).toEqual({
        id: 'goal',
        objective: 'Ship the feature',
        status: GoalStatus.ACTIVE,
        createdAt: '2026-10-20T14:00:00.000Z',
        continuationCount: 0,
        idleContinuationsWithoutToolCalls: 0,
        activeDurationMs: 0,
        activeSince: '2026-10-20T14:00:00.000Z',
      });
    });

    it.each(['', '   ', 'x'.repeat(4001)])('rejects an unusable objective: %j', objective => {
      expect(() => Goal.create('goal', objective, new Date())).toThrow();
    });
  });

  describe(Goal.from, () => {
    it('round-trips the stored record without copying it', () => {
      const record = Goal.create('goal', 'Ship', new Date()).toChatGoal();

      const goal = Goal.from(record);

      expect(goal.toChatGoal()).toBe(record);
      expect(goal.id).toBe('goal');
      expect(goal.status).toBe(GoalStatus.ACTIVE);
    });
  });

  describe('isOpen', () => {
    it('treats active and paused goals as open and completed goals as closed', () => {
      const record = Goal.create('goal', 'Ship', new Date()).toChatGoal();

      expect(Goal.from(record).isOpen).toBe(true);
      expect(Goal.from({ ...record, status: GoalStatus.PAUSED }).isOpen).toBe(true);
      expect(Goal.from({ ...record, status: GoalStatus.COMPLETE }).isOpen).toBe(false);
    });
  });

  describe(Goal.prototype.elapsedMs, () => {
    it('adds the running span to time already worked', () => {
      const record = Goal.create('goal', 'Ship', new Date('2026-10-20T14:00:00.000Z')).toChatGoal();

      expect(Goal.from({ ...record, activeDurationMs: 5000 }).elapsedMs(new Date('2026-10-20T14:00:02.500Z'))).toBe(
        7500,
      );
    });

    it('never counts backwards when the clock moves behind the activation time', () => {
      const goal = Goal.create('goal', 'Ship', new Date('2026-10-20T14:00:00.000Z'));

      expect(goal.elapsedMs(new Date('2026-10-20T13:59:00.000Z'))).toBe(0);
    });

    it('reports only time already worked while the clock is stopped', () => {
      const goal = Goal.create('goal', 'Ship', new Date('2026-10-20T14:00:00.000Z')).pause(
        GoalPauseReason.USER,
        new Date('2026-10-20T14:00:03.000Z'),
      );

      expect(goal.elapsedMs(new Date('2026-10-20T15:00:00.000Z'))).toBe(3000);
    });
  });

  describe(Goal.prototype.pause, () => {
    it('stops the clock and records why the goal paused', () => {
      const goal = Goal.create('goal', 'Ship', new Date('2026-10-20T14:00:00.000Z'));

      const paused = goal.pause(GoalPauseReason.FAILED, new Date('2026-10-20T14:01:00.000Z')).toChatGoal();

      expect(paused).toMatchObject({ status: GoalStatus.PAUSED, pauseReason: 'failed', activeDurationMs: 60_000 });
      expect(paused.activeSince).toBeUndefined();
    });

    it('leaves the original goal unchanged', () => {
      const goal = Goal.create('goal', 'Ship', new Date());

      goal.pause(GoalPauseReason.USER, new Date());

      expect(goal.status).toBe(GoalStatus.ACTIVE);
    });

    it('refuses to pause a goal that is not active', () => {
      const record = Goal.create('goal', 'Ship', new Date()).toChatGoal();

      expect(() =>
        Goal.from({ ...record, status: GoalStatus.COMPLETE }).pause(GoalPauseReason.USER, new Date()),
      ).toThrow(GoalError);
    });
  });

  describe(Goal.prototype.resume, () => {
    it('restarts the clock and forgets the idle streak and pause reason', () => {
      const paused = Goal.create('goal', 'Ship', new Date()).pause(GoalPauseReason.STALLED, new Date()).toChatGoal();

      const resumed = Goal.from({ ...paused, idleContinuationsWithoutToolCalls: 3 })
        .resume(new Date('2026-10-20T15:00:00.000Z'))
        .toChatGoal();

      expect(resumed).toMatchObject({
        status: GoalStatus.ACTIVE,
        idleContinuationsWithoutToolCalls: 0,
        activeSince: '2026-10-20T15:00:00.000Z',
      });
      expect(resumed.pauseReason).toBeUndefined();
    });

    it('refuses to resume a goal that is not paused', () => {
      expect(() => Goal.create('goal', 'Ship', new Date()).resume(new Date())).toThrow(GoalError);
    });
  });

  describe(Goal.prototype.complete, () => {
    it('completes an active goal and keeps the total time worked', () => {
      const goal = Goal.create('goal', 'Ship', new Date('2026-10-20T14:00:00.000Z'));

      const complete = goal.complete(new Date('2026-10-20T14:03:05.000Z')).toChatGoal();

      expect(complete).toMatchObject({ status: GoalStatus.COMPLETE, activeDurationMs: 185_000 });
      expect(complete.activeSince).toBeUndefined();
    });

    it('completes a paused goal when the human asks to stop it', () => {
      const paused = Goal.create('goal', 'Ship', new Date()).pause(GoalPauseReason.USER, new Date());

      const complete = paused.complete(new Date()).toChatGoal();

      expect(complete.status).toBe(GoalStatus.COMPLETE);
      expect(complete.pauseReason).toBeUndefined();
    });

    it('refuses to complete a goal twice', () => {
      const complete = Goal.create('goal', 'Ship', new Date()).complete(new Date());

      expect(() => complete.complete(new Date())).toThrow(GoalError);
    });
  });

  describe(Goal.prototype.beginContinuation, () => {
    it('counts each continuation of the same active goal', () => {
      const goal = Goal.create('goal', 'Ship', new Date());

      expect(goal.beginContinuation('goal').toChatGoal().continuationCount).toBe(1);
    });

    it.each([
      { goalId: 'other', status: GoalStatus.ACTIVE },
      { goalId: 'goal', status: GoalStatus.PAUSED },
      { goalId: 'goal', status: GoalStatus.COMPLETE },
    ])('refuses to continue a goal that changed: %j', ({ goalId, status }) => {
      const record = Goal.create('goal', 'Ship', new Date()).toChatGoal();

      expect(() => Goal.from({ ...record, status }).beginContinuation(goalId)).toThrow(GoalError);
    });
  });

  describe(Goal.prototype.recordContinuation, () => {
    it('clears the idle streak after a continuation that used tools', () => {
      const record = Goal.create('goal', 'Ship', new Date()).toChatGoal();

      const goal = Goal.from({ ...record, idleContinuationsWithoutToolCalls: 2 }).recordContinuation(
        'goal',
        true,
        new Date(),
      );

      expect(goal.toChatGoal().idleContinuationsWithoutToolCalls).toBe(0);
    });

    it('returns the same goal when a working continuation has nothing to clear', () => {
      const goal = Goal.create('goal', 'Ship', new Date());

      expect(goal.recordContinuation('goal', true, new Date())).toBe(goal);
    });

    it('extends the idle streak after a continuation without tool calls', () => {
      const goal = Goal.create('goal', 'Ship', new Date());

      expect(goal.recordContinuation('goal', false, new Date()).toChatGoal()).toMatchObject({
        status: GoalStatus.ACTIVE,
        idleContinuationsWithoutToolCalls: 1,
      });
    });

    it('pauses a goal that keeps continuing without doing any work', () => {
      const record = Goal.create('goal', 'Ship', new Date()).toChatGoal();

      const goal = Goal.from({
        ...record,
        idleContinuationsWithoutToolCalls: Goal.MAX_IDLE_CONTINUATIONS - 1,
      }).recordContinuation('goal', false, new Date());

      expect(goal.toChatGoal()).toMatchObject({
        status: GoalStatus.PAUSED,
        pauseReason: 'stalled',
        idleContinuationsWithoutToolCalls: Goal.MAX_IDLE_CONTINUATIONS,
      });
    });

    it.each([
      { goalId: 'other', status: GoalStatus.ACTIVE },
      { goalId: 'goal', status: GoalStatus.COMPLETE },
    ])('leaves a goal that changed during the continuation untouched: %j', ({ goalId, status }) => {
      const record = Goal.create('goal', 'Ship', new Date()).toChatGoal();
      const goal = Goal.from({ ...record, status });

      expect(goal.recordContinuation(goalId, false, new Date())).toBe(goal);
    });
  });
});
