import { describe, expect, it, vi } from 'vitest';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { GoalToolRuntime } from '#src/goals/GoalToolRuntime.js';
import { GoalStatus } from '#src/goals/GoalStatus.js';
import { Goal } from '#src/goals/Goal.js';

describe(GoalToolRuntime, () => {
  it('offers both goal tools in Agent and Plan modes and asks for approval in a round of its own', () => {
    const runtime = new GoalToolRuntime(vi.fn(), vi.fn());

    expect(
      runtime.tools.map(tool => [tool.namespace, tool.name, tool.allowedModes, tool.requiresExclusiveRound]),
    ).toEqual([
      ['goal', 'create_goal', [AgentModeID.AGENT, AgentModeID.PLAN], true],
      ['goal', 'update_goal', [AgentModeID.AGENT, AgentModeID.PLAN], undefined],
    ]);
  });

  it('validates inputs before execution', () => {
    const runtime = new GoalToolRuntime(vi.fn(), vi.fn());
    const [create, update] = runtime.tools;

    expect(() => {
      create!.validateInput(JSON.stringify({ objective: 'Ship' }));
    }).not.toThrow();
    expect(() => {
      create!.validateInput(JSON.stringify({ objective: ' ' }));
    }).toThrow();
    expect(() => {
      update!.validateInput(JSON.stringify({ status: 'complete' }));
    }).not.toThrow();
    expect(() => {
      update!.validateInput(JSON.stringify({ status: 'paused' }));
    }).toThrow();
  });

  describe(GoalToolRuntime.prototype.execute, () => {
    it('reports an approved goal proposal with the armed goal', async () => {
      const chat = { id: 'chat', accountProvider: 'fixture', accountId: 'account' };
      const goal = Goal.create('goal', 'Ship the feature', new Date('2026-10-20T14:00:00.000Z')).toChatGoal();
      const propose = vi.fn(async () => goal);
      const runtime = new GoalToolRuntime(propose, vi.fn());
      const signal = new AbortController().signal;

      const result = JSON.parse(
        await runtime.execute('create_goal', JSON.stringify({ objective: 'Ship the feature' }), signal, { chat }),
      );

      expect(result).toEqual({ approved: true, goal });
      expect(propose).toHaveBeenCalledWith(chat, 'Ship the feature', signal);
    });

    it('tells the agent to carry on when the human declines a goal', async () => {
      const chat = { id: 'chat', accountProvider: 'fixture', accountId: 'account' };
      const runtime = new GoalToolRuntime(
        vi.fn(async () => undefined),
        vi.fn(),
      );

      const result = JSON.parse(
        await runtime.execute('create_goal', JSON.stringify({ objective: 'Ship' }), undefined, { chat }),
      );

      expect(result).toEqual({
        approved: false,
        message: 'The human declined the goal. Continue with the current request.',
      });
    });

    it('returns the updated goal after a status change', async () => {
      const chat = { id: 'chat', accountProvider: 'fixture', accountId: 'account' };
      const goal = { ...Goal.create('goal', 'Ship', new Date()).toChatGoal(), status: GoalStatus.COMPLETE };
      const update = vi.fn(async () => goal);
      const runtime = new GoalToolRuntime(vi.fn(), update);

      const result = JSON.parse(
        await runtime.execute('update_goal', JSON.stringify({ status: 'complete' }), undefined, { chat }),
      );

      expect(result).toEqual({ goal });
      expect(update).toHaveBeenCalledWith(chat, 'complete', undefined);
    });

    it('reports host refusals as goal failures', async () => {
      const chat = { id: 'chat', accountProvider: 'fixture', accountId: 'account' };
      const runtime = new GoalToolRuntime(
        vi.fn(),
        vi.fn(async () => {
          throw new Error('This chat has no goal.');
        }),
      );

      const result = JSON.parse(
        await runtime.execute('update_goal', JSON.stringify({ status: 'complete' }), undefined, { chat }),
      );

      expect(result).toEqual({ error: { code: 'GOAL_UPDATE_FAILED', message: 'This chat has no goal.' } });
    });

    it('reports a non-error refusal with a generic message', async () => {
      const chat = { id: 'chat', accountProvider: 'fixture', accountId: 'account' };
      const runtime = new GoalToolRuntime(vi.fn(), vi.fn().mockRejectedValue('offline'));

      const result = JSON.parse(
        await runtime.execute('update_goal', JSON.stringify({ status: 'active' }), undefined, { chat }),
      );

      expect(result).toEqual({ error: { code: 'GOAL_UPDATE_FAILED', message: 'Could not update the goal.' } });
    });

    it.each([
      ['create_goal', '{"objective":""}'],
      ['create_goal', 'not json'],
      ['update_goal', '{"status":"paused"}'],
    ])('rejects malformed %s input without touching the goal', async (name, input) => {
      const chat = { id: 'chat', accountProvider: 'fixture', accountId: 'account' };
      const propose = vi.fn();
      const update = vi.fn();
      const runtime = new GoalToolRuntime(propose, update);

      expect(JSON.parse(await runtime.execute(name, input, undefined, { chat }))).toMatchObject({
        error: { code: 'MALFORMED' },
      });
      expect(propose).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('requires a host-owned chat', async () => {
      const propose = vi.fn();
      const runtime = new GoalToolRuntime(propose, vi.fn());

      expect(JSON.parse(await runtime.execute('create_goal', JSON.stringify({ objective: 'Ship' })))).toEqual({
        error: { code: 'GOAL_UPDATE_FAILED', message: 'A host-owned chat is required to manage goals.' },
      });
      expect(propose).not.toHaveBeenCalled();
    });

    it('propagates cancellation instead of reporting it as a tool failure', async () => {
      const chat = { id: 'chat', accountProvider: 'fixture', accountId: 'account' };
      const propose = vi.fn();
      const runtime = new GoalToolRuntime(propose, vi.fn());

      await expect(
        runtime.execute('create_goal', JSON.stringify({ objective: 'Ship' }), AbortSignal.abort(new Error('Stopped')), {
          chat,
        }),
      ).rejects.toThrow('Stopped');
      expect(propose).not.toHaveBeenCalled();
    });

    it('rejects unknown tool names', async () => {
      const runtime = new GoalToolRuntime(vi.fn(), vi.fn());

      await expect(runtime.execute('pause_goal', '{}')).rejects.toThrow('Unknown goal tool: pause_goal');
    });
  });
});
