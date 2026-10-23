import { describe, expect, it, vi } from 'vitest';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import {
  GlyphGoalReconciler,
  goalContinuationKey,
  type GlyphGoalReconciliationSnapshot,
} from '#src/desktop/workbench/GlyphGoalReconciler.js';

describe(goalContinuationKey, () => {
  it.each([GlyphRunStatus.FAILED, GlyphRunStatus.CANCELLED, GlyphRunStatus.INTERRUPTED])(
    'continues an explicitly resumed or newly armed goal after a %s run',
    status => {
      const snapshot: GlyphGoalReconciliationSnapshot = {
        goal: {
          id: 'goal',
          objective: 'Finish',
          status: 'active',
          createdAt: '2026-10-20T14:00:00.000Z',
          continuationCount: 0,
          idleContinuationsWithoutToolCalls: 0,
          activeDurationMs: 0,
        },
        runs: [{ runId: 'old', status }],
        connected: true,
        ownsWorkspace: true,
        submitting: false,
        queuedMessages: 0,
      };
      expect(goalContinuationKey(snapshot)).toBeDefined();
      expect(goalContinuationKey({ ...snapshot, goal: { ...snapshot.goal!, status: 'paused' } })).toBeUndefined();
    },
  );
  it('identifies an idle chat with an active goal as ready to continue', () => {
    const snapshot: GlyphGoalReconciliationSnapshot = {
      goal: {
        id: 'goal',
        objective: 'Make CI green',
        status: 'active',
        createdAt: '2026-10-20T14:00:00.000Z',
        continuationCount: 2,
        idleContinuationsWithoutToolCalls: 0,
        activeDurationMs: 0,
        activeSince: '2026-10-20T14:00:00.000Z',
      },
      runs: [{ runId: 'run', status: GlyphRunStatus.COMPLETED }],
      connected: true,
      ownsWorkspace: true,
      submitting: false,
      queuedMessages: 0,
    };

    expect(goalContinuationKey(snapshot)).toBe(['goal', 2, '2026-10-20T14:00:00.000Z', 'run'].join('\0'));
  });

  it('continues a freshly armed goal in a chat without any turns', () => {
    const snapshot: GlyphGoalReconciliationSnapshot = {
      goal: {
        id: 'goal',
        objective: 'Make CI green',
        status: 'active',
        createdAt: '2026-10-20T14:00:00.000Z',
        continuationCount: 0,
        idleContinuationsWithoutToolCalls: 0,
        activeDurationMs: 0,
      },
      runs: [],
      connected: true,
      ownsWorkspace: true,
      submitting: false,
      queuedMessages: 0,
    };

    expect(goalContinuationKey(snapshot)).toBe(['goal', 0, '', ''].join('\0'));
  });

  it.each([
    ['the goal is paused', { goal: { status: 'paused' as const } }],
    ['the goal is complete', { goal: { status: 'complete' as const } }],
    ['the chat has no goal', { goal: undefined }],
    ['the host is disconnected', { connected: false }],
    ['another window owns the workspace', { ownsWorkspace: false }],
    ['a message is being submitted', { submitting: true }],
    ['follow-up messages are queued', { queuedMessages: 1 }],
    ['a turn is still running', { runs: [{ runId: 'run', status: GlyphRunStatus.STREAMING }] }],
    ['a question is waiting for an answer', { runs: [{ runId: 'run', status: GlyphRunStatus.WAITING_FOR_QUESTION }] }],
    [
      'an approval is waiting for a decision',
      { runs: [{ runId: 'run', status: GlyphRunStatus.WAITING_FOR_APPROVAL }] },
    ],
  ])('holds the goal while %s', (_, change) => {
    const base: GlyphGoalReconciliationSnapshot = {
      goal: {
        id: 'goal',
        objective: 'Make CI green',
        status: 'active',
        createdAt: '2026-10-20T14:00:00.000Z',
        continuationCount: 0,
        idleContinuationsWithoutToolCalls: 0,
        activeDurationMs: 0,
      },
      runs: [{ runId: 'run', status: GlyphRunStatus.COMPLETED }],
      connected: true,
      ownsWorkspace: true,
      submitting: false,
      queuedMessages: 0,
    };
    const { goal: goalChange, ...rest } = change as Partial<GlyphGoalReconciliationSnapshot> & {
      goal?: Partial<NonNullable<GlyphGoalReconciliationSnapshot['goal']>>;
    };
    const snapshot = {
      ...base,
      ...rest,
      ...('goal' in change ? (goalChange ? { goal: { ...base.goal!, ...goalChange } } : { goal: undefined }) : {}),
    } as GlyphGoalReconciliationSnapshot;

    expect(goalContinuationKey(snapshot)).toBeUndefined();
  });
});

describe(GlyphGoalReconciler, () => {
  describe(GlyphGoalReconciler.prototype.reconcile, () => {
    it('asks the host to continue an idle goal once per goal state', async () => {
      const snapshot: GlyphGoalReconciliationSnapshot = {
        goal: {
          id: 'goal',
          objective: 'Make CI green',
          status: 'active',
          createdAt: '2026-10-20T14:00:00.000Z',
          continuationCount: 0,
          idleContinuationsWithoutToolCalls: 0,
          activeDurationMs: 0,
        },
        runs: [],
        connected: true,
        ownsWorkspace: true,
        submitting: false,
        queuedMessages: 0,
      };
      const continueGoal = vi.fn(async () => {});
      const reconciler = new GlyphGoalReconciler({ snapshot: () => snapshot, continueGoal, onError: vi.fn() });

      reconciler.reconcile('chat');
      await vi.waitFor(() => {
        expect(continueGoal).toHaveBeenCalledOnce();
      });
      reconciler.reconcile('chat');

      expect(continueGoal).toHaveBeenCalledWith('chat', 'goal');
      expect(continueGoal).toHaveBeenCalledOnce();
    });

    it('asks again after the goal moves on to a new continuation', async () => {
      let snapshot: GlyphGoalReconciliationSnapshot = {
        goal: {
          id: 'goal',
          objective: 'Make CI green',
          status: 'active',
          createdAt: '2026-10-20T14:00:00.000Z',
          continuationCount: 0,
          idleContinuationsWithoutToolCalls: 0,
          activeDurationMs: 0,
        },
        runs: [],
        connected: true,
        ownsWorkspace: true,
        submitting: false,
        queuedMessages: 0,
      };
      const continueGoal = vi.fn(async () => {});
      const reconciler = new GlyphGoalReconciler({ snapshot: () => snapshot, continueGoal, onError: vi.fn() });
      reconciler.reconcile('chat');
      await vi.waitFor(() => {
        expect(continueGoal).toHaveBeenCalledOnce();
      });

      snapshot = {
        ...snapshot,
        goal: { ...snapshot.goal!, continuationCount: 1 },
        runs: [{ runId: 'goal-continuation:goal:1', status: GlyphRunStatus.COMPLETED }],
      };
      reconciler.reconcile('chat');

      await vi.waitFor(() => {
        expect(continueGoal).toHaveBeenCalledTimes(2);
      });
    });

    it('never asks for a second continuation while the first request is in flight, then catches up', async () => {
      let snapshot: GlyphGoalReconciliationSnapshot = {
        goal: {
          id: 'goal',
          objective: 'Make CI green',
          status: 'active',
          createdAt: '2026-10-20T14:00:00.000Z',
          continuationCount: 0,
          idleContinuationsWithoutToolCalls: 0,
          activeDurationMs: 0,
        },
        runs: [],
        connected: true,
        ownsWorkspace: true,
        submitting: false,
        queuedMessages: 0,
      };
      let release!: () => void;
      const continueGoal = vi.fn(
        () =>
          new Promise<void>(resolve => {
            release = resolve;
          }),
      );
      const reconciler = new GlyphGoalReconciler({ snapshot: () => snapshot, continueGoal, onError: vi.fn() });
      reconciler.reconcile('chat');

      snapshot = { ...snapshot, goal: { ...snapshot.goal!, continuationCount: 1 } };
      reconciler.reconcile('chat');
      expect(continueGoal).toHaveBeenCalledOnce();
      release();

      await vi.waitFor(() => {
        expect(continueGoal).toHaveBeenCalledTimes(2);
      });
    });

    it('reports a failed request without retrying the same goal state', async () => {
      const snapshot: GlyphGoalReconciliationSnapshot = {
        goal: {
          id: 'goal',
          objective: 'Make CI green',
          status: 'active',
          createdAt: '2026-10-20T14:00:00.000Z',
          continuationCount: 0,
          idleContinuationsWithoutToolCalls: 0,
          activeDurationMs: 0,
        },
        runs: [],
        connected: true,
        ownsWorkspace: true,
        submitting: false,
        queuedMessages: 0,
      };
      const failure = new Error('Host unavailable');
      const continueGoal = vi.fn(async () => {
        throw failure;
      });
      const onError = vi.fn();
      const reconciler = new GlyphGoalReconciler({ snapshot: () => snapshot, continueGoal, onError });

      reconciler.reconcile('chat');
      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledWith(failure);
      });
      reconciler.reconcile('chat');

      expect(continueGoal).toHaveBeenCalledOnce();
    });

    it('ignores chats it cannot describe or that are not ready', () => {
      const continueGoal = vi.fn(async () => {});
      const reconciler = new GlyphGoalReconciler({ snapshot: () => undefined, continueGoal, onError: vi.fn() });

      reconciler.reconcile('missing');

      expect(continueGoal).not.toHaveBeenCalled();
    });
  });

  describe(GlyphGoalReconciler.prototype.reset, () => {
    it('allows the same goal state to be continued again after a reconnect', async () => {
      const snapshot: GlyphGoalReconciliationSnapshot = {
        goal: {
          id: 'goal',
          objective: 'Make CI green',
          status: 'active',
          createdAt: '2026-10-20T14:00:00.000Z',
          continuationCount: 0,
          idleContinuationsWithoutToolCalls: 0,
          activeDurationMs: 0,
        },
        runs: [],
        connected: true,
        ownsWorkspace: true,
        submitting: false,
        queuedMessages: 0,
      };
      const continueGoal = vi.fn(async () => {});
      const reconciler = new GlyphGoalReconciler({ snapshot: () => snapshot, continueGoal, onError: vi.fn() });
      reconciler.reconcile('chat');
      await vi.waitFor(() => {
        expect(continueGoal).toHaveBeenCalledOnce();
      });

      reconciler.reset();
      reconciler.reconcile('chat');

      await vi.waitFor(() => {
        expect(continueGoal).toHaveBeenCalledTimes(2);
      });
    });
  });
});
