import { describe, expect, it, vi } from 'vitest';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { PlanToolRuntime } from '#src/planning/PlanToolRuntime.js';
import { planSchema } from '#src/planning/PlanSchema.js';

function planInput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: 'Ship coverage',
    summary: 'Cover every branch.',
    markdown: '# Plan',
    todos: [{ id: 'one', text: 'Write tests', completed: false }],
    id: null,
    expectedRevision: null,
    ...overrides,
  });
}

describe(PlanToolRuntime, () => {
  it('preserves persisted plan build state', () => {
    const build = { chatId: 'builder', runId: 'run', startedAt: '2026-10-23T10:00:00Z' };

    expect(
      planSchema.parse({
        id: 'plan',
        revision: 1,
        title: 'Ship coverage',
        summary: 'Cover every branch.',
        markdown: '# Plan',
        todos: [],
        agents: [],
        build,
      }).build,
    ).toEqual(build);
  });
  it('exposes a save_plan tool available in agent and plan modes', () => {
    const runtime = new PlanToolRuntime(vi.fn());

    expect(runtime.tools).toHaveLength(1);
    expect(runtime.tools[0]).toMatchObject({
      namespace: 'planning',
      name: 'save_plan',
      allowedModes: [AgentModeID.AGENT, AgentModeID.PLAN],
    });
    expect(runtime.tools[0]!.parameters).not.toHaveProperty('$schema');
  });

  it('validates plan input through its tool', () => {
    const runtime = new PlanToolRuntime(vi.fn());
    const [tool] = runtime.tools;

    expect(() => {
      tool!.validateInput(planInput());
    }).not.toThrow();
    expect(() => {
      tool!.validateInput(planInput({ id: 'plan' }));
    }).toThrow('An existing plan requires its expected revision.');
    expect(() => {
      tool!.validateInput(
        planInput({
          todos: [
            { id: 'one', text: 'Write tests', completed: false },
            { id: 'one', text: 'Again', completed: true },
          ],
        }),
      );
    }).toThrow('Todo IDs must be unique.');
  });

  it('saves through its tool on behalf of the owning chat', async () => {
    const save = vi.fn(async () => ({ id: 'plan', revision: 1 }));
    const runtime = new PlanToolRuntime(save);
    const signal = new AbortController().signal;
    const chat = { id: 'chat', accountProvider: 'fixture', accountId: 'account' };

    expect(JSON.parse(await runtime.tools[0]!.execute(planInput(), signal, { chat }))).toEqual({
      id: 'plan',
      revision: 1,
    });
    expect(save).toHaveBeenCalledWith(chat, JSON.parse(planInput()), signal);
  });

  describe(PlanToolRuntime.prototype.execute, () => {
    it('reports a failure when no owning chat is supplied', async () => {
      const save = vi.fn();
      const runtime = new PlanToolRuntime(save);

      expect(JSON.parse(await runtime.execute('save_plan', planInput()))).toEqual({
        error: { code: 'PLAN_SAVE_FAILED', message: 'Saving a plan requires its owning chat.' },
      });
      expect(save).not.toHaveBeenCalled();
    });

    it('reports a failure for tools it does not provide', async () => {
      const save = vi.fn();
      const runtime = new PlanToolRuntime(save);

      expect(
        JSON.parse(
          await runtime.execute('delete_plan', planInput(), undefined, {
            chat: { id: 'chat', accountProvider: 'fixture', accountId: 'account' },
          }),
        ),
      ).toEqual({ error: { code: 'PLAN_SAVE_FAILED', message: 'Saving a plan requires its owning chat.' } });
      expect(save).not.toHaveBeenCalled();
    });

    it('reports non-error failures as text', async () => {
      const runtime = new PlanToolRuntime(
        vi.fn(async () => {
          throw 'disk full';
        }),
      );

      expect(
        JSON.parse(
          await runtime.execute('save_plan', planInput(), undefined, {
            chat: { id: 'chat', accountProvider: 'fixture', accountId: 'account' },
          }),
        ),
      ).toEqual({ error: { code: 'PLAN_SAVE_FAILED', message: 'disk full' } });
    });

    it('rethrows when cancelled', async () => {
      const save = vi.fn();
      const runtime = new PlanToolRuntime(save);
      const reason = new Error('Stopped');

      await expect(
        runtime.execute('save_plan', planInput(), AbortSignal.abort(reason), {
          chat: { id: 'chat', accountProvider: 'fixture', accountId: 'account' },
        }),
      ).rejects.toBe(reason);
      expect(save).not.toHaveBeenCalled();
    });
  });
});
