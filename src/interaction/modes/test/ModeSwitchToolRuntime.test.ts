import { describe, expect, it, vi } from 'vitest';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { ModeSwitchToolRuntime } from '#src/interaction/modes/ModeSwitchToolRuntime.js';

describe(ModeSwitchToolRuntime, () => {
  it('exposes an exclusive mode-switch tool that names every mode', () => {
    const runtime = new ModeSwitchToolRuntime(vi.fn());

    expect(runtime.tools).toHaveLength(1);
    expect(runtime.tools[0]).toMatchObject({
      namespace: 'interaction',
      name: 'request_mode_switch',
      requiresExclusiveRound: true,
      allowedModes: [AgentModeID.AGENT, AgentModeID.PLAN],
    });
    expect(runtime.tools[0]!.description).toContain('(Agent, Plan)');
    expect(runtime.tools[0]!.parameters).not.toHaveProperty('$schema');
  });

  it('validates requests through its tool', () => {
    const [tool] = new ModeSwitchToolRuntime(vi.fn()).tools;

    expect(() => tool!.validateInput(JSON.stringify({ target: 'plan', description: 'Need a plan' }))).not.toThrow();
    expect(() => tool!.validateInput(JSON.stringify({ target: 'chaos', description: 'Why not' }))).toThrow();
    expect(() => tool!.validateInput(JSON.stringify({ target: 'plan', description: '   ' }))).toThrow();
    expect(() =>
      tool!.validateInput(JSON.stringify({ target: 'plan', description: 'Need a plan', extra: true })),
    ).toThrow();
  });

  it('switches modes through its tool once approved', async () => {
    const request = vi.fn(async () => true);
    const onModeChanged = vi.fn();
    const signal = new AbortController().signal;
    const context = {
      mode: AgentModeID.AGENT,
      onModeChanged,
      chat: { id: 'chat', accountProvider: 'fixture', accountId: 'account' },
    };

    const output = await new ModeSwitchToolRuntime(request).tools[0]!.execute(
      JSON.stringify({ target: 'plan', description: 'Need a plan' }),
      signal,
      context,
    );

    expect(JSON.parse(output)).toEqual({
      approved: true,
      mode: 'plan',
      message: 'Switched to plan mode. Follow its tool permissions for subsequent calls.',
    });
    expect(request).toHaveBeenCalledWith(AgentModeID.PLAN, 'Need a plan', context, signal);
    expect(onModeChanged).toHaveBeenCalledWith(AgentModeID.PLAN);
  });

  describe(ModeSwitchToolRuntime.prototype.execute, () => {
    it.each([
      {
        label: 'an unknown tool name',
        name: 'other_tool',
        withSignal: true,
        context: {
          onModeChanged: () => {},
          chat: { id: 'chat', accountProvider: 'fixture', accountId: 'account' },
        },
      },
      {
        label: 'no owning chat',
        name: 'request_mode_switch',
        withSignal: true,
        context: { onModeChanged: () => {} },
      },
      {
        label: 'no mode-change callback',
        name: 'request_mode_switch',
        withSignal: true,
        context: { chat: { id: 'chat', accountProvider: 'fixture', accountId: 'account' } },
      },
      {
        label: 'no cancellation signal',
        name: 'request_mode_switch',
        withSignal: false,
        context: {
          onModeChanged: () => {},
          chat: { id: 'chat', accountProvider: 'fixture', accountId: 'account' },
        },
      },
    ])('refuses to run with $label', async ({ name, withSignal, context }) => {
      const request = vi.fn();
      const runtime = new ModeSwitchToolRuntime(request);

      const output = await runtime.execute(
        name,
        JSON.stringify({ target: 'plan', description: 'Need a plan' }),
        withSignal ? new AbortController().signal : undefined,
        context,
      );

      expect(JSON.parse(output)).toEqual({ error: 'Mode changes require an active, owned chat run.' });
      expect(request).not.toHaveBeenCalled();
    });

    it('refuses to run without any context', async () => {
      const output = await new ModeSwitchToolRuntime(vi.fn()).execute(
        'request_mode_switch',
        JSON.stringify({ target: 'plan', description: 'Need a plan' }),
        new AbortController().signal,
      );

      expect(JSON.parse(output)).toEqual({ error: 'Mode changes require an active, owned chat run.' });
    });

    it('declines without asking when the target is already the current mode', async () => {
      const request = vi.fn();
      const onModeChanged = vi.fn();

      const output = await new ModeSwitchToolRuntime(request).execute(
        'request_mode_switch',
        JSON.stringify({ target: 'plan', description: 'Stay here' }),
        new AbortController().signal,
        {
          mode: AgentModeID.PLAN,
          onModeChanged,
          chat: { id: 'chat', accountProvider: 'fixture', accountId: 'account' },
        },
      );

      expect(JSON.parse(output)).toEqual({ approved: false, mode: 'plan', message: 'Already in this mode.' });
      expect(request).not.toHaveBeenCalled();
      expect(onModeChanged).not.toHaveBeenCalled();
    });

    it('keeps the current mode when the switch is denied', async () => {
      const onModeChanged = vi.fn();

      const output = await new ModeSwitchToolRuntime(vi.fn(async () => false)).execute(
        'request_mode_switch',
        JSON.stringify({ target: 'agent', description: 'Ready to build' }),
        new AbortController().signal,
        {
          mode: AgentModeID.PLAN,
          onModeChanged,
          chat: { id: 'chat', accountProvider: 'fixture', accountId: 'account' },
        },
      );

      expect(JSON.parse(output)).toEqual({
        approved: false,
        mode: 'plan',
        message: 'The mode switch was denied. Continue in the current mode.',
      });
      expect(onModeChanged).not.toHaveBeenCalled();
    });

    it('rejects malformed requests', async () => {
      const request = vi.fn();

      await expect(
        new ModeSwitchToolRuntime(request).execute(
          'request_mode_switch',
          '{"target":"plan"}',
          new AbortController().signal,
          {
            mode: AgentModeID.AGENT,
            onModeChanged: () => {},
            chat: { id: 'chat', accountProvider: 'fixture', accountId: 'account' },
          },
        ),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    });
  });
});
